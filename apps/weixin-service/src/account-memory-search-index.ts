import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { extractStrongAnchors, mergeReciprocalRanks, rankExactCosine, type MemorySearchCandidate } from "./account-memory-resolver.js";

export interface EmbeddingContract {
  readonly model: string;
  readonly revision: string;
  readonly dtype: string;
  readonly dimensions: number;
  readonly pooling: "mean" | "last_token";
  readonly normalized: true;
  readonly queryTemplateVersion: string;
  readonly documentTemplateVersion: string;
  readonly maxLength: number;
  readonly runtimeVersion: string;
}

export interface EmbeddedDocument {
  readonly vector: Float32Array;
  readonly truncated: boolean;
}

export interface MemoryEmbedder {
  readonly contract: EmbeddingContract;
  embedQuery(text: string): Promise<Float32Array>;
  embedDocuments(texts: readonly string[]): Promise<EmbeddedDocument[]>;
}

export class LocalTransformersMemoryEmbedder implements MemoryEmbedder {
  readonly contract: EmbeddingContract = {
    model: "Xenova/paraphrase-multilingual-MiniLM-L12-v2",
    revision: "2c4055b",
    dtype: "q4f16",
    dimensions: 384,
    pooling: "mean",
    normalized: true,
    queryTemplateVersion: "raw-v1",
    documentTemplateVersion: "raw-v1",
    maxLength: 128,
    runtimeVersion: "transformers-js-3.8.1",
  };
  private extractor: Promise<(text: string) => Promise<Float32Array>> | undefined;

  async embedQuery(text: string): Promise<Float32Array> {
    this.extractor ??= this.load();
    return (await this.extractor)(text);
  }

  async embedDocuments(texts: readonly string[]): Promise<EmbeddedDocument[]> {
    return Promise.all(texts.map(async (text) => ({ vector: await this.embedQuery(text), truncated: false })));
  }

  private async load(): Promise<(text: string) => Promise<Float32Array>> {
    const { pipeline } = await import("@huggingface/transformers");
    const extractor = await pipeline("feature-extraction", this.contract.model, { dtype: "q4f16" });
    return async (text: string) => {
      const output = await extractor(text, { pooling: "mean", normalize: true });
      const data = (output as unknown as { data: ArrayLike<number> }).data;
      const vector = Float32Array.from(data);
      if (vector.length !== this.contract.dimensions) throw new Error("memory_embedding_dimensions_invalid");
      return normalizeVector(vector);
    };
  }
}

type QwenRuntime = {
  extract(input: string, options: Record<string, unknown>): Promise<{ data: ArrayLike<number> }>;
  countTokens(text: string): number | Promise<number>;
};

export class Qwen3MemoryEmbeddingProfile implements MemoryEmbedder {
  readonly contract: EmbeddingContract = {
    model: "onnx-community/Qwen3-Embedding-0.6B-ONNX",
    revision: "c25a394dd583836952667c12f008335071b3f43d",
    dtype: "q8",
    dimensions: 1024,
    pooling: "last_token",
    normalized: true,
    queryTemplateVersion: "personal-memory-en-v1",
    documentTemplateVersion: "raw-v1",
    maxLength: 512,
    runtimeVersion: "transformers-js-3.8.1",
  };
  private runtime: Promise<QwenRuntime> | undefined;

  constructor(private readonly loadRuntime: () => Promise<QwenRuntime> = defaultQwenRuntimeLoader) {}

  async embedQuery(text: string): Promise<Float32Array> {
    return this.extract(`Instruct: Given a personal-memory query, retrieve relevant memory passages that answer the query\nQuery:${text}`);
  }

  async embedDocuments(texts: readonly string[]): Promise<EmbeddedDocument[]> {
    const runtime = await this.getRuntime();
    const results: EmbeddedDocument[] = [];
    for (const text of texts) {
      results.push({
        vector: await this.extract(text),
        truncated: await runtime.countTokens(text) > this.contract.maxLength,
      });
    }
    return results;
  }

  private async extract(text: string): Promise<Float32Array> {
    const runtime = await this.getRuntime();
    const output = await runtime.extract(text, {
      pooling: "last_token",
      normalize: true,
      truncation: true,
      max_length: this.contract.maxLength,
    });
    const vector = Float32Array.from(output.data);
    if (vector.length !== this.contract.dimensions || vector.some((value) => !Number.isFinite(value))) {
      throw new Error("memory_embedding_dimensions_invalid");
    }
    return normalizeVector(vector);
  }

  private getRuntime(): Promise<QwenRuntime> {
    this.runtime ??= this.loadRuntime();
    return this.runtime;
  }
}

async function defaultQwenRuntimeLoader(): Promise<QwenRuntime> {
  const { AutoTokenizer, pipeline } = await import("@huggingface/transformers");
  const model = "onnx-community/Qwen3-Embedding-0.6B-ONNX";
  const revision = "c25a394dd583836952667c12f008335071b3f43d";
  const load = async (local_files_only: boolean) => Promise.all([
    pipeline("feature-extraction", model, { dtype: "q8", revision, local_files_only }),
    AutoTokenizer.from_pretrained(model, { revision, local_files_only }),
  ] as const);
  let runtime;
  try {
    runtime = await load(true);
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (!/(?:local_files_only|not found locally)/u.test(message)) throw error;
    runtime = await load(false);
  }
  const [extractor, tokenizer] = runtime;
  return {
    extract: async (input, options) => extractor(input, options),
    countTokens: async (text) => {
      const encoded = await tokenizer(text, { truncation: false });
      const ids = (encoded as unknown as { input_ids: { dims: number[] } }).input_ids;
      return ids.dims.at(-1) ?? 0;
    },
  };
}

export type AccountMemoryEmbeddingStatus = {
  state: "idle" | "building" | "active" | "failed";
  activeModel?: string;
  candidateModel?: string;
  rollbackModel?: string;
  indexedEntries: number;
  totalEntries: number;
  generation: number;
  lastError?: string;
};

export class AccountMemorySearchIndex {
  private readonly profiles = new Map<string, MemoryEmbedder>();
  private readonly candidate: MemoryEmbedder | undefined;
  private readonly preparing = new Map<string, Promise<void>>();
  private readonly prepareAgain = new Set<string>();

  constructor(
    private readonly root: string,
    private readonly primary: MemoryEmbedder,
    options: { candidate?: MemoryEmbedder } = {},
  ) {
    this.candidate = options.candidate;
    this.profiles.set(profileId(primary), primary);
    if (this.candidate) this.profiles.set(profileId(this.candidate), this.candidate);
  }

  async search(accountId: string, query: string): Promise<MemorySearchCandidate[]> {
    const databasePath = this.databasePath(accountId);
    if (!fs.existsSync(databasePath)) return [];
    this.assertSafeDatabase(databasePath);
    const database = new DatabaseSync(databasePath);
    database.exec("PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
    try {
      this.ensureSchema(database);
      const lexical = this.searchLexical(database, query);
      try {
        const embedder = this.activeProfile(database);
        const activeProfileId = this.ensureProfile(database, embedder);
        if (!this.candidate) await this.ensureEntryEmbeddings(database, embedder);
        const queryVector = normalizeVector(await embedder.embedQuery(query));
        const rows = database.prepare(`
          SELECT e.id, e.value, m.value_hash, m.vector_blob
          FROM entries e JOIN entry_embeddings_v2 m ON m.entry_id = e.id
          WHERE m.profile_id = ? AND m.dimensions = ? AND m.normalized = 1
          ORDER BY e.id
        `).all(activeProfileId, embedder.contract.dimensions) as Array<{ id: string; value: string; value_hash: string; vector_blob: Uint8Array }>;
        const currentRows = rows.filter((row) => row.value_hash === hash(row.value));
        const ids = currentRows.map((row) => row.id);
        const vectors = new Float32Array(ids.length * embedder.contract.dimensions);
        currentRows.forEach((row, index) => vectors.set(bufferToVector(row.vector_blob, embedder.contract.dimensions), index * embedder.contract.dimensions));
        const semantic = rankExactCosine(queryVector, vectors, ids, embedder.contract.dimensions, 50);
        return mergeReciprocalRanks(lexical, semantic, 50);
      } catch {
        return lexical;
      }
    } finally {
      database.close();
    }
  }

  prepare(accountId: string): Promise<void> {
    const running = this.preparing.get(accountId);
    if (running) {
      this.prepareAgain.add(accountId);
      return running;
    }
    const task = (async () => {
      do {
        this.prepareAgain.delete(accountId);
        try {
          await this.prepareAccount(accountId);
        } catch (error) {
          if (!this.prepareAgain.has(accountId)) throw error;
        }
      } while (this.prepareAgain.has(accountId));
    })().finally(() => this.preparing.delete(accountId));
    this.preparing.set(accountId, task);
    return task;
  }

  getStatus(accountId: string): AccountMemoryEmbeddingStatus {
    const databasePath = this.databasePath(accountId);
    if (!fs.existsSync(databasePath)) return { state: "idle", indexedEntries: 0, totalEntries: 0, generation: 0 };
    this.assertSafeDatabase(databasePath);
    const database = new DatabaseSync(databasePath);
    try {
      this.ensureSchema(database);
      const row = database.prepare("SELECT active_profile_id, candidate_profile_id, rollback_profile_id, generation, state, last_error_code FROM account_embedding_state WHERE singleton = 1")
        .get() as Record<string, unknown>;
      const total = Number((database.prepare("SELECT COUNT(*) AS count FROM entries").get() as { count: number }).count);
      const activeId = typeof row.active_profile_id === "string" ? row.active_profile_id : undefined;
      const progressId = row.state === "building" && typeof row.candidate_profile_id === "string"
        ? row.candidate_profile_id
        : activeId;
      const indexed = progressId ? this.currentCoverage(database, progressId) : 0;
      return {
        state: normalizeIndexState(row.state),
        ...(activeId ? { activeModel: this.profileModel(database, activeId) } : {}),
        ...(typeof row.candidate_profile_id === "string" ? { candidateModel: this.profileModel(database, row.candidate_profile_id) } : {}),
        ...(typeof row.rollback_profile_id === "string" ? { rollbackModel: this.profileModel(database, row.rollback_profile_id) } : {}),
        indexedEntries: indexed,
        totalEntries: total,
        generation: Number(row.generation),
        ...(typeof row.last_error_code === "string" ? { lastError: row.last_error_code } : {}),
      };
    } finally {
      database.close();
    }
  }

  rollback(accountId: string): boolean {
    const databasePath = this.databasePath(accountId);
    if (!fs.existsSync(databasePath)) return false;
    const database = new DatabaseSync(databasePath);
    database.exec("PRAGMA busy_timeout = 5000; BEGIN IMMEDIATE;");
    try {
      this.ensureSchema(database);
      const row = database.prepare("SELECT active_profile_id, rollback_profile_id FROM account_embedding_state WHERE singleton = 1").get() as {
        active_profile_id: string | null; rollback_profile_id: string | null;
      };
      if (!row.active_profile_id || !row.rollback_profile_id || !this.profiles.has(row.rollback_profile_id)) {
        database.exec("ROLLBACK");
        return false;
      }
      database.prepare(`
        UPDATE account_embedding_state
        SET active_profile_id = ?, rollback_profile_id = ?, candidate_profile_id = NULL,
            generation = generation + 1, state = 'rolled_back', last_error_code = NULL, switched_at = ?
        WHERE singleton = 1
      `).run(row.rollback_profile_id, row.active_profile_id, Date.now());
      database.exec("COMMIT");
      return true;
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    } finally {
      database.close();
    }
  }

  private searchLexical(database: DatabaseSync, query: string): MemorySearchCandidate[] {
    const tokens = extractStrongAnchors(query);
    if (tokens.length === 0) return [];
    const match = tokens.map((token) => `"${token.replaceAll('"', '""')}"`).join(" OR ");
    try {
      const rows = database.prepare("SELECT entry_id, bm25(entries_fts) AS score FROM entries_fts WHERE entries_fts MATCH ? ORDER BY score, entry_id LIMIT 50")
        .all(match) as Array<{ entry_id: string; score: number }>;
      return rows.map((row, index) => ({ id: row.entry_id, rank: index + 1, score: -Number(row.score), source: "lexical" }));
    } catch { return []; }
  }

  private async prepareAccount(accountId: string): Promise<void> {
    const databasePath = this.databasePath(accountId);
    if (!fs.existsSync(databasePath)) return;
    this.assertSafeDatabase(databasePath);
    const database = new DatabaseSync(databasePath);
    database.exec("PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
    const primaryId = this.ensureProfile(database, this.primary);
    const candidate = this.candidate;
    const candidateId = candidate ? this.ensureProfile(database, candidate) : undefined;
    const previous = database.prepare("SELECT active_profile_id, state FROM account_embedding_state WHERE singleton = 1").get() as {
      active_profile_id: string | null; state: string;
    };
    const rolledBack = previous.state === "rolled_back";
    const candidateAlreadyActive = Boolean(candidateId && previous.active_profile_id === candidateId);
    database.prepare(`
      UPDATE account_embedding_state
      SET active_profile_id = COALESCE(active_profile_id, ?), candidate_profile_id = ?,
          state = 'building', last_error_code = NULL
      WHERE singleton = 1
    `).run(primaryId, rolledBack || candidateAlreadyActive ? null : candidateId ?? null);
    try {
      await this.ensureEntryEmbeddings(database, this.primary);
      if (candidate && candidateId) {
        await this.ensureEntryEmbeddings(database, candidate);
        const total = Number((database.prepare("SELECT COUNT(*) AS count FROM entries").get() as { count: number }).count);
        const indexed = this.currentCoverage(database, candidateId);
        if (indexed !== total) throw new Error("memory_embedding_coverage_incomplete");
        if (rolledBack) {
          database.prepare("UPDATE account_embedding_state SET candidate_profile_id = NULL, state = 'rolled_back', last_error_code = NULL WHERE singleton = 1").run();
        } else if (candidateAlreadyActive) {
          database.prepare("UPDATE account_embedding_state SET candidate_profile_id = NULL, state = 'active', last_error_code = NULL WHERE singleton = 1").run();
        } else {
          database.exec("BEGIN IMMEDIATE;");
          database.prepare(`
            UPDATE account_embedding_state
            SET active_profile_id = ?, candidate_profile_id = NULL, rollback_profile_id = ?,
                generation = generation + 1, state = 'active', last_error_code = NULL, switched_at = ?
            WHERE singleton = 1
          `).run(candidateId, primaryId, Date.now());
          database.exec("COMMIT");
        }
      } else {
        database.prepare("UPDATE account_embedding_state SET state = 'active', last_error_code = NULL WHERE singleton = 1").run();
      }
    } catch (error) {
      database.prepare("UPDATE account_embedding_state SET state = 'failed', last_error_code = ? WHERE singleton = 1")
        .run(publicIndexError(error));
      throw error;
    } finally {
      database.close();
    }
  }

  private async ensureEntryEmbeddings(database: DatabaseSync, embedder: MemoryEmbedder): Promise<void> {
    const currentProfileId = this.ensureProfile(database, embedder);
    const allRows = database.prepare(`
      SELECT e.id, e.value, m.value_hash
      FROM entries e LEFT JOIN entry_embeddings_v2 m
        ON m.entry_id = e.id AND m.profile_id = ?
      ORDER BY e.id
    `).all(currentProfileId) as Array<{ id: string; value: string; value_hash: string | null }>;
    const rows = allRows.filter((row) => row.value_hash !== hash(row.value));
    if (rows.length === 0) return;
    const embedded = await embedder.embedDocuments(rows.map((row) => row.value));
    for (const [index, row] of rows.entries()) {
      const valueHash = hash(row.value);
      const result = embedded[index];
      if (!result) throw new Error("memory_embedding_result_missing");
      const vector = normalizeVector(result.vector);
      if (vector.length !== embedder.contract.dimensions) throw new Error("memory_embedding_dimensions_invalid");
      const current = database.prepare("SELECT value FROM entries WHERE id = ?").get(row.id) as { value: string } | undefined;
      if (!current || hash(current.value) !== valueHash) continue;
      database.prepare(`
        INSERT INTO entry_embeddings_v2(entry_id, profile_id, dimensions, normalized, vector_blob, value_hash, truncated)
        VALUES (?, ?, ?, 1, ?, ?, ?)
        ON CONFLICT(entry_id, profile_id) DO UPDATE SET dimensions=excluded.dimensions,
          normalized=1, vector_blob=excluded.vector_blob, value_hash=excluded.value_hash, truncated=0
      `).run(row.id, currentProfileId, embedder.contract.dimensions, vectorToBuffer(vector), valueHash, result.truncated ? 1 : 0);
      database.prepare("DELETE FROM embedding_outbox WHERE entry_id = ? AND value_hash = ?").run(row.id, valueHash);
    }
  }

  private ensureProfile(database: DatabaseSync, embedder: MemoryEmbedder): string {
    this.ensureSchema(database);
    const contract = JSON.stringify(embedder.contract);
    const profileId = hash(contract);
    database.prepare("INSERT OR IGNORE INTO embedding_profiles(profile_id, contract_json, created_at) VALUES (?, ?, ?)")
      .run(profileId, contract, Date.now());
    return profileId;
  }

  private activeProfile(database: DatabaseSync): MemoryEmbedder {
    const row = database.prepare("SELECT active_profile_id FROM account_embedding_state WHERE singleton = 1").get() as { active_profile_id: string | null };
    return (row.active_profile_id ? this.profiles.get(row.active_profile_id) : undefined) ?? this.primary;
  }

  private profileModel(database: DatabaseSync, id: string): string {
    const row = database.prepare("SELECT contract_json FROM embedding_profiles WHERE profile_id = ?").get(id) as { contract_json: string } | undefined;
    if (!row) return "unknown";
    try { return String((JSON.parse(row.contract_json) as { model?: unknown }).model ?? "unknown"); }
    catch { return "unknown"; }
  }

  private currentCoverage(database: DatabaseSync, id: string): number {
    const rows = database.prepare(`
      SELECT e.value, m.value_hash
      FROM entries e JOIN entry_embeddings_v2 m ON m.entry_id = e.id
      WHERE m.profile_id = ?
    `).all(id) as Array<{ value: string; value_hash: string }>;
    return rows.filter((row) => row.value_hash === hash(row.value)).length;
  }

  private ensureSchema(database: DatabaseSync): void {
    database.exec(`
      CREATE TABLE IF NOT EXISTS embedding_profiles (
        profile_id TEXT PRIMARY KEY, contract_json TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS entry_embeddings_v2 (
        entry_id TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
        profile_id TEXT NOT NULL REFERENCES embedding_profiles(profile_id) ON DELETE CASCADE,
        dimensions INTEGER NOT NULL, normalized INTEGER NOT NULL, vector_blob BLOB NOT NULL,
        value_hash TEXT NOT NULL, truncated INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(entry_id, profile_id)
      );
      CREATE TABLE IF NOT EXISTS account_embedding_state (
        singleton INTEGER PRIMARY KEY CHECK(singleton = 1), active_profile_id TEXT,
        candidate_profile_id TEXT, rollback_profile_id TEXT, generation INTEGER NOT NULL DEFAULT 0,
        state TEXT NOT NULL DEFAULT 'idle', last_error_code TEXT, switched_at INTEGER
      );
      INSERT OR IGNORE INTO account_embedding_state(singleton, state) VALUES (1, 'idle');
    `);
  }

  private databasePath(accountId: string): string {
    const scope = crypto.createHash("sha256").update(accountId).digest("hex");
    return path.join(this.root, "accounts", scope, "memory.sqlite");
  }

  private assertSafeDatabase(databasePath: string): void {
    for (const candidate of [this.root, path.dirname(path.dirname(databasePath)), path.dirname(databasePath), databasePath]) {
      if (!fs.existsSync(candidate)) continue;
      const info = fs.lstatSync(candidate);
      if (info.isSymbolicLink()) throw new Error("memory_scope_unsafe");
    }
  }
}

function profileId(embedder: MemoryEmbedder): string { return hash(JSON.stringify(embedder.contract)); }

function normalizeIndexState(value: unknown): AccountMemoryEmbeddingStatus["state"] {
  if (value === "rolled_back") return "active";
  return value === "building" || value === "active" || value === "failed" ? value : "idle";
}

function publicIndexError(error: unknown): string {
  return error instanceof Error && [
    "memory_embedding_dimensions_invalid",
    "memory_embedding_result_missing",
    "memory_embedding_coverage_incomplete",
  ].includes(error.message) ? error.message : "memory_embedding_build_failed";
}

function normalizeVector(vector: Float32Array): Float32Array {
  let squared = 0;
  for (const value of vector) squared += value * value;
  const norm = Math.sqrt(squared);
  if (norm === 0) return new Float32Array(vector);
  return Float32Array.from(vector, (value) => value / norm);
}

function vectorToBuffer(vector: Float32Array): Buffer {
  return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
}

function bufferToVector(value: Uint8Array, dimensions: number): Float32Array {
  const copy = Buffer.from(value);
  if (copy.byteLength !== dimensions * Float32Array.BYTES_PER_ELEMENT) throw new Error("memory_embedding_dimensions_invalid");
  return new Float32Array(copy.buffer.slice(copy.byteOffset, copy.byteOffset + copy.byteLength));
}

function hash(value: string): string { return crypto.createHash("sha256").update(value).digest("hex"); }
