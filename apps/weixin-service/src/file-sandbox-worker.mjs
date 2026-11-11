/* global Buffer, process, TextDecoder, performance */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const MAX_FRAME_BYTES = 1024 * 1024;
const MAX_SCANNED_ENTRIES = 10_000;
const MAX_GREP_FILE_BYTES = 1024 * 1024;
const MAX_READ_FILE_BYTES = 4 * 1024 * 1024;
const WORD_SEGMENTER = new Intl.Segmenter("und", { granularity: "word" });
let input = Buffer.alloc(0);
let access;
const preparedAcks = new Map();

process.stdin.on("data", (chunk) => {
  input = Buffer.concat([input, chunk]);
  consume();
});

function consume() {
  while (input.length >= 4) {
    const length = input.readUInt32BE(0);
    if (length < 2 || length > MAX_FRAME_BYTES) process.exit(70);
    if (input.length < length + 4) return;
    const body = input.subarray(4, length + 4);
    input = input.subarray(length + 4);
    void handleFrame(body);
  }
}

async function handleFrame(body) {
  let request;
  try {
    request = JSON.parse(body.toString("utf8"));
    if (!request || typeof request.requestId !== "string") throw new Error("file_sandbox_protocol_invalid");
    if (request.type === "init") {
      if (access !== undefined) throw new Error("file_sandbox_already_initialized");
      access = validateAccess(request.access);
      respond(request.requestId, true, { ready: true });
      return;
    }
    if (access === undefined) throw new Error("file_sandbox_protocol_invalid");
    if (request.type === "prepared_ack") {
      const acknowledge = preparedAcks.get(request.requestId);
      if (!acknowledge || typeof request.commit !== "boolean") throw new Error("file_sandbox_protocol_invalid");
      preparedAcks.delete(request.requestId);
      acknowledge(request.commit);
      return;
    }
    if (request.type === "verify_read_denied") {
      respond(request.requestId, true, await verifyReadDenied(request.absolutePath));
      return;
    }
    if (request.type !== "execute") throw new Error("file_sandbox_protocol_invalid");
    const result = request.operation?.type === "find"
      ? await find(request.operation)
      : request.operation?.type === "grep"
        ? await grep(request.operation)
        : request.operation?.type === "read" || request.operation?.type === "inspect"
          ? await read(request.operation)
          : request.operation?.type === "plan_edit"
            ? await planEdit(request.operation)
            : request.operation?.type === "edit"
            ? await edit(request.operation, request.prepareMutation ? request.requestId : undefined)
            : request.operation?.type === "write"
              ? await write(request.operation, request.prepareMutation ? request.requestId : undefined)
              : request.operation?.type === "snapshot"
                ? await snapshot(request.operation)
                : request.operation?.type === "cleanup_prepared"
                  ? await cleanupPrepared(request.operation)
                  : (() => { throw new Error("file_sandbox_operation_unsupported"); })();
    respond(request.requestId, true, result);
  } catch (error) {
    if (request && typeof request.requestId === "string") {
      respond(request.requestId, false, undefined, safeError(error));
    } else {
      process.exit(70);
    }
  }
}

async function verifyReadDenied(absolutePath) {
  if (typeof absolutePath !== "string" || !path.isAbsolute(absolutePath)) {
    throw new Error("file_sandbox_probe_invalid");
  }
  try {
    await fs.promises.readFile(absolutePath);
    return { denied: false };
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ERR_ACCESS_DENIED") {
      return { denied: true };
    }
    throw error;
  }
}

function validateAccess(value) {
  if (!value || typeof value !== "object" || !Array.isArray(value.scopes) || value.scopes.length > 64) {
    throw new Error("file_sandbox_access_invalid");
  }
  const scopes = value.scopes.map((scope) => {
    if (!scope || typeof scope.scopeRef !== "string" || typeof scope.scopeId !== "string" || typeof scope.directory !== "string" ||
        !path.isAbsolute(scope.directory) || typeof scope.read !== "boolean" || typeof scope.write !== "boolean") {
      throw new Error("file_sandbox_access_invalid");
    }
    return {
      scopeRef: scope.scopeRef,
      scopeId: scope.scopeId,
      directory: scope.directory,
      read: scope.read,
      write: scope.write,
      closedRoots: narrowingRoots(scope.closedRoots),
      readOnlyRoots: narrowingRoots(scope.readOnlyRoots),
    };
  });
  if (typeof value.spoolDirectory !== "string" || !path.isAbsolute(value.spoolDirectory)) {
    throw new Error("file_sandbox_access_invalid");
  }
  const deniedRoots = value.deniedRoots ?? [];
  if (!Array.isArray(deniedRoots) || deniedRoots.length > 100 || deniedRoots.some((root) => typeof root !== "string" || !path.isAbsolute(root))) {
    throw new Error("file_sandbox_access_invalid");
  }
  const folded = deniedRoots.map(foldDeniedPath);
  return { scopes: scopes.filter((scope) => !folded.some((root) => isContainedPath(root, foldDeniedPath(scope.directory)))),
    spoolDirectory: value.spoolDirectory, deniedRoots: folded };
}

function narrowingRoots(value = []) {
  if (!Array.isArray(value) || value.some((root) => typeof root !== "string" || !path.isAbsolute(root))) {
    throw new Error("file_sandbox_access_invalid");
  }
  return value.map(foldDeniedPath);
}

// Refused through `scope`: the service's own state lies outside every grant, and a scope saved below this one closes its
// directory or, for a write, leaves it read-only (workflow-module-permissions, failure mode 4).
function isDeniedPath(candidate, scope, forWrite = false) {
  const folded = foldDeniedPath(candidate);
  const holds = (root) => isContainedPath(root, folded);
  return access.deniedRoots.some(holds) || scope.closedRoots.some(holds) || (forWrite && scope.readOnlyRoots.some(holds));
}

// Case- and normalization-insensitive volumes (APFS) give one file many spellings; a protected location that does not
// exist yet must not be reachable by creating it under another spelling. Folding can only widen what is refused.
function foldDeniedPath(value) {
  return value.normalize("NFC").toLowerCase();
}

const findScans = new Map();

// Streaming traversal retains at most one small metadata window per directory depth.
async function* findEntries(scopes, concurrency) {
  for (const scope of scopes) {
    const rootInfo = await fs.promises.lstat(scope.directory);
    const root = await fs.promises.realpath(scope.directory);
    async function* visit(directory, parts) {
      const handle = await fs.promises.opendir(directory);
      try {
        while (true) {
          const window = [];
          for (let index = 0; index < concurrency; index += 1) {
            const entry = await handle.read();
            if (!entry) break;
            window.push(entry);
          }
          if (!window.length) return;
          window.sort((left, right) => stableCompare(left.name, right.name));
          const observations = await Promise.all(window.map(async (entry) => {
            if (!safeEntryName(entry.name) || entry.isSymbolicLink()) return undefined;
            const absolutePath = path.join(directory, entry.name);
            if (isDeniedPath(absolutePath, scope)) return undefined;
            const info = await fs.promises.lstat(absolutePath);
            if (info.isSymbolicLink() || info.dev !== rootInfo.dev) return undefined;
            const kind = info.isDirectory() ? "directory" : info.isFile() ? "file" : undefined;
            return kind ? { entry, absolutePath, info, kind } : undefined;
          }));
          for (const observation of observations) {
            // Count excluded entries too, so a large symlink-only directory remains bounded.
            if (!observation) { yield undefined; continue; }
            const { entry, absolutePath, info, kind } = observation;
            const nextParts = [...parts, entry.name];
            yield { scopeRef: scope.scopeRef, fileName: entry.name, relativePath: nextParts.join("/"),
              kind, sizeBytes: kind === "file" ? info.size : 0, modifiedAt: info.mtimeMs };
            if (kind === "directory" && !isApplePhotosLibrary(entry.name)) {
              const real = await fs.promises.realpath(absolutePath);
              if (isDeniedPath(real, scope)) continue;
              const relative = path.relative(root, real);
              if (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) {
                yield* visit(real, nextParts);
              }
            }
          }
        }
      } finally { await handle.close(); }
    }
    yield* visit(root, []);
  }
}

async function find(operation) {
  validateFind(operation);
  const { scanCursor, batchSize, cancelScan, metadataConcurrency = 16, budget: rawBudget, ...queryIdentity } = operation;
  if ((batchSize !== undefined && (!positiveInteger(batchSize) || batchSize > 2048)) ||
      !positiveInteger(metadataConcurrency) || metadataConcurrency > 32 ||
      (scanCursor !== undefined && (typeof scanCursor !== "string" || batchSize === undefined)) ||
      (cancelScan !== undefined && (typeof cancelScan !== "boolean" || !scanCursor))) {
    throw new Error("file_sandbox_operation_invalid");
  }
  const budget = traversalBudget(rawBudget, false);
  const identity = JSON.stringify(queryIdentity);
  let state;
  if (scanCursor !== undefined) {
    state = findScans.get(scanCursor);
    if (!state || state.identity !== identity || state.busy) throw new Error("file_sandbox_cursor_invalid");
    findScans.delete(scanCursor);
  } else {
    if (findScans.size >= 8) throw new Error("file_sandbox_query_budget_exhausted");
    const allowedRefs = operation.scopeRefs ? new Set(operation.scopeRefs) : undefined;
    const scopes = access.scopes.filter((scope) => scope.read && (!allowedRefs || allowedRefs.has(scope.scopeRef)));
    if (!scopes.length) throw new Error("file_sandbox_permission_denied");
    state = { identity, iterator: findEntries(scopes, metadataConcurrency), candidates: [], matches: 0 };
  }
  if (cancelScan) {
    await state.iterator.return();
    return { entries: [], scanComplete: false, resultTruncated: false, scannedEntries: 0, scannedFiles: 0, scannedBytes: 0 };
  }
  state.busy = true;
  const query = operation.query ?? "";
  const caseMode = operation.case ?? "smart";
  const caseSensitive = caseMode === "sensitive" || (caseMode === "smart" && /[A-Z]/u.test(query));
  const needle = normalize(query, caseSensitive);
  const kind = operation.kind ?? "any";
  const limit = operation.limit ?? 20;
  const sort = operation.sort ?? { field: "relevance", direction: "desc" };
  const direction = sort.direction === "asc" ? 1 : -1;
  const compare = (left, right) => {
    const primary = sort.field === "modified_at" ? (left.modifiedAt - right.modifiedAt) * direction
      : sort.field === "name" ? stableCompare(left.fileName, right.fileName) * direction
        : sort.field === "path" ? stableCompare(left.relativePath, right.relativePath) * direction
          : (left.relevanceScore - right.relevanceScore) * direction;
    return primary || stableCompare(left.relativePath, right.relativePath) || compareScopeRefs(left.scopeRef, right.scopeRef);
  };
  let scannedEntries = 0, scannedFiles = 0, scannedBytes = 0;
  let scanComplete = false, continuation;
  const started = performance.now();
  try {
    while (true) {
      const next = await state.iterator.next();
      if (next.done) { scanComplete = true; break; }
      const entry = next.value;
      if (scannedEntries >= budget.maxScannedEntries || (entry?.kind === "file" && scannedFiles >= budget.maxScannedFiles)) break;
      scannedEntries += 1;
      if (entry?.kind === "file") { scannedFiles += 1; scannedBytes += entry.sizeBytes; }
      if (entry) {
        const score = matchScore(normalize(entry.fileName, caseSensitive), normalize(entry.relativePath, caseSensitive), needle, operation.match ?? "fuzzy");
        if ((kind === "any" || kind === entry.kind) && score > 0 && matchesGlobs(entry.relativePath, operation.include, operation.exclude, caseSensitive)) {
          state.matches += 1;
          const candidate = { ...entry, relevanceScore: score };
          let low = 0, high = state.candidates.length;
          while (low < high) {
            const middle = (low + high) >>> 1;
            if (compare(candidate, state.candidates[middle]) < 0) high = middle;
            else low = middle + 1;
          }
          if (low < limit) {
            state.candidates.splice(low, 0, candidate);
            if (state.candidates.length > limit) state.candidates.pop();
          }
        }
      }
      if (batchSize !== undefined && (scannedEntries >= batchSize || performance.now() - started >= 200)) {
        continuation = crypto.randomUUID();
        state.busy = false;
        findScans.set(continuation, state);
        break;
      }
    }
  } finally {
    if (!continuation) await state.iterator.return();
  }
  return { entries: state.candidates, scanComplete, resultTruncated: state.matches > limit,
    scannedEntries, scannedFiles, scannedBytes, ...(continuation ? { scanCursor: continuation } : {}) };
}

async function grep(operation) {
  validateGrep(operation);
  const allowedRefs = operation.scopeRefs ? new Set(operation.scopeRefs) : undefined;
  const scopes = access.scopes.filter((scope) => scope.read && (!allowedRefs || allowedRefs.has(scope.scopeRef)));
  if (scopes.length === 0) throw new Error("file_sandbox_permission_denied");
  const caseMode = operation.case ?? "smart";
  const caseSensitive = caseMode === "sensitive" || (caseMode === "smart" && /[A-Z]/u.test(operation.pattern));
  const mode = operation.mode ?? "literal";
  const literal = normalize(operation.pattern, caseSensitive);
  let expression;
  if (mode === "regex") {
    try {
      expression = new RegExp(operation.pattern, caseSensitive ? "u" : "iu");
    } catch {
      throw new Error("file_sandbox_regex_invalid");
    }
  }
  const contextLines = operation.contextLines ?? 0;
  const limit = operation.limit ?? 20;
  const budget = traversalBudget(operation.budget, true);
  const matches = [];
  const skipped = [];
  let scanned = 0;
  let scannedFiles = 0;
  let scannedBytes = 0;
  let grepBytes = 0;
  let scanComplete = true;

  for (const scope of scopes) {
    const rootInfo = await fs.promises.lstat(scope.directory);
    const root = await fs.promises.realpath(scope.directory);
    const visit = async (directory, parts) => {
      const entries = await fs.promises.readdir(directory, { withFileTypes: true });
      entries.sort((left, right) => stableCompare(left.name, right.name));
      for (const entry of entries) {
        if (scanned >= budget.maxScannedEntries) {
          scanComplete = false;
          return;
        }
        if (!safeEntryName(entry.name) || entry.isSymbolicLink()) continue;
        const nextParts = [...parts, entry.name];
        const relativePath = nextParts.join("/");
        const absolutePath = path.join(directory, entry.name);
        if (isDeniedPath(absolutePath, scope)) continue;
        const info = await fs.promises.lstat(absolutePath);
        if (info.isSymbolicLink() || info.dev !== rootInfo.dev) continue;
        if (info.isDirectory()) {
          scanned += 1;
          if (!isApplePhotosLibrary(entry.name)) {
            const real = await fs.promises.realpath(absolutePath);
            if (isDeniedPath(real, scope)) continue;
            const relative = path.relative(root, real);
            if (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) {
              await visit(real, nextParts);
            }
          }
          if (!scanComplete) return;
          continue;
        }
        if (!info.isFile()) continue;
        if (scannedFiles >= budget.maxScannedFiles || scannedBytes + info.size > budget.maxScannedBytes) {
          scanComplete = false;
          return;
        }
        scanned += 1;
        scannedFiles += 1;
        scannedBytes += info.size;
        if (!matchesGlobs(relativePath, operation.include, operation.exclude, caseSensitive)) continue;
        if (info.size > MAX_GREP_FILE_BYTES) {
          if (skipped.length < 100) skipped.push({ scopeRef: scope.scopeRef, relativePath, reason: "too_large" });
          continue;
        }
        if (grepBytes + info.size > budget.maxGrepBytes) {
          scanComplete = false;
          return;
        }
        const handle = await fs.promises.open(absolutePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
        let body;
        try {
          body = await handle.readFile();
        } finally {
          await handle.close();
        }
        grepBytes += body.length;
        if (body.includes(0)) {
          if (skipped.length < 100) skipped.push({ scopeRef: scope.scopeRef, relativePath, reason: "binary" });
          continue;
        }
        let text;
        try {
          text = new TextDecoder("utf-8", { fatal: true }).decode(body);
        } catch {
          if (skipped.length < 100) skipped.push({ scopeRef: scope.scopeRef, relativePath, reason: "decode_failed" });
          continue;
        }
        const lines = text.split(/\r?\n/u);
        for (let index = 0; index < lines.length; index += 1) {
          const line = lines[index] ?? "";
          const hit = expression ? expression.test(line) : normalize(line, caseSensitive).includes(literal);
          if (!hit) continue;
          matches.push({
            scopeRef: scope.scopeRef,
            fileName: entry.name,
            relativePath,
            line: index + 1,
            text: line.slice(0, 500),
            before: lines.slice(Math.max(0, index - contextLines), index).map((value) => value.slice(0, 500)),
            after: lines.slice(index + 1, index + 1 + contextLines).map((value) => value.slice(0, 500)),
            sizeBytes: info.size,
            modifiedAt: info.mtimeMs,
          });
        }
      }
    };
    await visit(root, []);
    if (!scanComplete) break;
  }

  matches.sort((left, right) => stableCompare(left.relativePath, right.relativePath) ||
    left.line - right.line || compareScopeRefs(left.scopeRef, right.scopeRef));
  return {
    matches: matches.slice(0, limit),
    skipped,
    scanComplete,
    resultTruncated: matches.length > limit,
    scannedEntries: scanned,
    scannedFiles,
    scannedBytes,
    grepBytes,
  };
}

async function read(operation) {
  validateRead(operation);
  const scope = access.scopes.find((candidate) => candidate.scopeRef === operation.scopeRef && candidate.read);
  if (!scope) throw new Error("file_sandbox_permission_denied");
  const root = await fs.promises.realpath(scope.directory);
  const relativePath = normalizeRelativePath(operation.relativePath);
  const candidate = path.join(root, ...relativePath.split("/"));
  if (isDeniedPath(candidate, scope)) throw new Error("file_sandbox_permission_denied");
  const initial = await fs.promises.lstat(candidate);
  if (!initial.isFile() || initial.isSymbolicLink()) throw new Error("file_sandbox_file_invalid");
  const real = await fs.promises.realpath(candidate);
  if (!isContainedPath(root, real) || isDeniedPath(real, scope)) throw new Error("file_sandbox_permission_denied");
  const handle = await fs.promises.open(real, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  let info;
  let body;
  try {
    info = await handle.stat();
    if (!info.isFile() || info.size > MAX_READ_FILE_BYTES) throw new Error("file_sandbox_file_too_large");
    body = await handle.readFile();
  } finally {
    await handle.close();
  }
  if (operation.type === "inspect") {
    return { sha256: sha256(body), sizeBytes: body.length, modifiedAt: info.mtimeMs, mode: info.mode & 0o777 };
  }
  if (body.includes(0)) throw new Error("file_sandbox_content_unsupported");
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    throw new Error("file_sandbox_content_unsupported");
  }
  const lines = text.split(/\r?\n/u);
  const startLine = operation.startLine ?? 1;
  const maxLines = operation.maxLines ?? 200;
  if (startLine > lines.length) throw new Error("file_sandbox_read_range_invalid");
  const selected = lines.slice(startLine - 1, startLine - 1 + maxLines);
  const endLine = startLine + selected.length - 1;
  const content = selected.join("\n");
  if (Array.from(content).length > (operation.maxCharacters ?? 100_000)) {
    throw new Error("file_sandbox_read_budget_exhausted");
  }
  return {
    content,
    startLine,
    endLine,
    totalLines: lines.length,
    truncated: startLine > 1 || endLine < lines.length,
    sha256: crypto.createHash("sha256").update(body).digest("hex"),
    sizeBytes: info.size,
    modifiedAt: info.mtimeMs,
  };
}

async function edit(operation, requestId) {
  validateEdit(operation);
  const target = await resolveWritableTarget(operation.scopeRef, operation.relativePath, true);
  const plan = await buildEditPlan(target.absolutePath, operation);
  await atomicReplace(target.absolutePath, plan.body, plan.mode, false, requestId, operation.expectedSha256);
  return mutationResult(target.absolutePath, plan.body);
}

async function planEdit(operation) {
  validateEdit(operation);
  const target = await resolveWritableTarget(operation.scopeRef, operation.relativePath, true);
  const plan = await buildEditPlan(target.absolutePath, operation);
  return {
    beforeSha256: operation.expectedSha256,
    afterSha256: sha256(plan.body),
    sizeBytes: plan.body.length,
    mode: plan.mode,
  };
}

async function buildEditPlan(absolutePath, operation) {
  const current = await readTextFile(absolutePath);
  if (sha256(current.body) !== operation.expectedSha256) throw new Error("file_sandbox_content_conflict");
  const oldText = normalizeNewlines(operation.oldText, current.newline);
  const newText = normalizeNewlines(operation.newText, current.newline);
  const occurrences = countOccurrences(current.text, oldText);
  if (occurrences === 0 || (!operation.replaceAll && occurrences !== 1)) throw new Error("file_sandbox_edit_conflict");
  const nextText = operation.replaceAll
    ? current.text.split(oldText).join(newText)
    : current.text.replace(oldText, newText);
  const encoded = Buffer.from(nextText, "utf8");
  const body = current.hasBom ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), encoded]) : encoded;
  return { body, mode: current.mode };
}

async function write(operation, requestId) {
  validateWrite(operation);
  const target = await resolveWritableTarget(operation.scopeRef, operation.relativePath, operation.overwrite);
  let mode = 0o600;
  if (operation.overwrite) {
    const current = await readTextFile(target.absolutePath);
    if (sha256(current.body) !== operation.expectedSha256) throw new Error("file_sandbox_content_conflict");
    mode = current.mode;
  } else {
    try {
      await fs.promises.lstat(target.absolutePath);
      throw new Error("file_sandbox_file_exists");
    } catch (error) {
      if (!error || typeof error !== "object" || error.code !== "ENOENT") throw error;
    }
  }
  const body = Buffer.from(operation.content, "utf8");
  await atomicReplace(target.absolutePath, body, mode, !operation.overwrite, requestId, operation.expectedSha256);
  return mutationResult(target.absolutePath, body);
}

async function snapshot(operation) {
  validateSnapshot(operation);
  const scope = access.scopes.find((candidate) => candidate.scopeRef === operation.scopeRef && candidate.read);
  if (!scope) throw new Error("file_sandbox_permission_denied");
  const root = await fs.promises.realpath(scope.directory);
  const relativePath = normalizeRelativePath(operation.relativePath);
  const source = await fs.promises.realpath(path.join(root, ...relativePath.split("/")));
  if (!isContainedPath(root, source) || isDeniedPath(source, scope)) throw new Error("file_sandbox_permission_denied");
  const handle = await fs.promises.open(source, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  let body;
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > 100 * 1024 * 1024) throw new Error("file_sandbox_file_invalid");
    if ((operation.expectedSizeBytes !== undefined && operation.expectedSizeBytes !== info.size) ||
        (operation.expectedModifiedAt !== undefined && operation.expectedModifiedAt !== info.mtimeMs)) {
      throw new Error("file_sandbox_content_conflict");
    }
    body = await handle.readFile();
  } finally {
    await handle.close();
  }
  const digest = sha256(body);
  if (operation.expectedSha256 && operation.expectedSha256 !== digest) throw new Error("file_sandbox_content_conflict");
  const fileName = path.basename(relativePath);
  const extension = path.extname(fileName).slice(0, 32);
  const snapshotPath = path.join(access.spoolDirectory, `${crypto.randomBytes(16).toString("hex")}${extension}`);
  const output = await fs.promises.open(snapshotPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
  try { await output.writeFile(body); } finally { await output.close(); }
  return { snapshotPath, fileName, sha256: digest, sizeBytes: body.length };
}

function validateFind(value) {
  if (!value || value.type !== "find" || (value.query !== undefined && typeof value.query !== "string") ||
      (value.limit !== undefined && (!Number.isSafeInteger(value.limit) || value.limit < 1 || value.limit > 500))) {
    throw new Error("file_sandbox_operation_invalid");
  }
}

function traversalBudget(value, grepOperation) {
  if (value === undefined) {
    return {
      maxScannedEntries: MAX_SCANNED_ENTRIES,
      maxScannedFiles: MAX_SCANNED_ENTRIES,
      maxScannedBytes: Number.MAX_SAFE_INTEGER,
      maxGrepBytes: Number.MAX_SAFE_INTEGER,
    };
  }
  if (!value || !positiveInteger(value.maxScannedEntries) || !positiveInteger(value.maxScannedFiles) ||
      !positiveInteger(value.maxScannedBytes) || (grepOperation && !positiveInteger(value.maxGrepBytes))) {
    throw new Error("file_sandbox_operation_invalid");
  }
  return value;
}

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function validateGrep(value) {
  if (!value || value.type !== "grep" || typeof value.pattern !== "string" || value.pattern.length < 1 ||
      Array.from(value.pattern).length > 512 ||
      (value.contextLines !== undefined && (!Number.isSafeInteger(value.contextLines) || value.contextLines < 0 || value.contextLines > 10)) ||
      (value.limit !== undefined && (!Number.isSafeInteger(value.limit) || value.limit < 1 || value.limit > 500))) {
    throw new Error("file_sandbox_operation_invalid");
  }
}

function validateRead(value) {
  if (!value || (value.type !== "read" && value.type !== "inspect") || typeof value.scopeRef !== "string" || value.scopeRef.length < 1 ||
      typeof value.relativePath !== "string" || value.relativePath.length < 1 || path.isAbsolute(value.relativePath) ||
      (value.startLine !== undefined && (!Number.isSafeInteger(value.startLine) || value.startLine < 1)) ||
      (value.maxCharacters !== undefined && (!Number.isSafeInteger(value.maxCharacters) || value.maxCharacters < 1 || value.maxCharacters > 100_000)) ||
      (value.maxLines !== undefined && (!Number.isSafeInteger(value.maxLines) || value.maxLines < 1 || value.maxLines > 500))) {
    throw new Error("file_sandbox_operation_invalid");
  }
}

function validateEdit(value) {
  if (!value || (value.type !== "edit" && value.type !== "plan_edit") || typeof value.scopeRef !== "string" || value.scopeRef.length < 1 ||
      typeof value.relativePath !== "string" || value.relativePath.length < 1 || path.isAbsolute(value.relativePath) ||
      !/^[a-f0-9]{64}$/u.test(value.expectedSha256) || typeof value.oldText !== "string" || value.oldText.length < 1 ||
      typeof value.newText !== "string" || Buffer.byteLength(value.oldText, "utf8") > MAX_READ_FILE_BYTES ||
      Buffer.byteLength(value.newText, "utf8") > MAX_READ_FILE_BYTES ||
      (value.replaceAll !== undefined && typeof value.replaceAll !== "boolean")) {
    throw new Error("file_sandbox_operation_invalid");
  }
}

function validateWrite(value) {
  if (!value || value.type !== "write" || typeof value.scopeRef !== "string" || value.scopeRef.length < 1 ||
      typeof value.relativePath !== "string" || value.relativePath.length < 1 || path.isAbsolute(value.relativePath) ||
      typeof value.content !== "string" || Buffer.byteLength(value.content, "utf8") > MAX_READ_FILE_BYTES ||
      typeof value.overwrite !== "boolean" ||
      (value.overwrite ? !/^[a-f0-9]{64}$/u.test(value.expectedSha256 ?? "") : value.expectedSha256 !== undefined)) {
    throw new Error("file_sandbox_operation_invalid");
  }
}

function validateSnapshot(value) {
  if (!value || value.type !== "snapshot" || typeof value.scopeRef !== "string" || value.scopeRef.length < 1 ||
      typeof value.relativePath !== "string" || value.relativePath.length < 1 || path.isAbsolute(value.relativePath) ||
      (value.expectedSha256 !== undefined && !/^[a-f0-9]{64}$/u.test(value.expectedSha256)) ||
      (value.expectedSizeBytes !== undefined && (!Number.isSafeInteger(value.expectedSizeBytes) || value.expectedSizeBytes < 0)) ||
      (value.expectedModifiedAt !== undefined && !Number.isFinite(value.expectedModifiedAt))) {
    throw new Error("file_sandbox_operation_invalid");
  }
}

async function resolveWritableTarget(scopeRef, relativePath, targetMustExist) {
  const scope = access.scopes.find((candidate) => candidate.scopeRef === scopeRef && candidate.write &&
    (!targetMustExist || candidate.read));
  if (!scope) throw new Error("file_sandbox_permission_denied");
  const root = await fs.promises.realpath(scope.directory);
  const normalized = normalizeRelativePath(relativePath);
  if (isDeniedPath(path.join(root, ...normalized.split("/")), scope, true)) throw new Error("file_sandbox_permission_denied");
  const segments = normalized.split("/");
  const fileName = segments.pop();
  if (!fileName) throw new Error("file_sandbox_operation_invalid");
  let parent = root;
  for (const segment of segments) {
    const next = path.join(parent, segment);
    if (isDeniedPath(next, scope, true)) throw new Error("file_sandbox_permission_denied");
    try {
      const info = await fs.promises.lstat(next);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("file_sandbox_path_unsafe");
    } catch (error) {
      if (!error || typeof error !== "object" || error.code !== "ENOENT" || targetMustExist) throw error;
      try {
        await fs.promises.mkdir(next, { mode: 0o700 });
      } catch (mkdirError) {
        if (!mkdirError || typeof mkdirError !== "object" || mkdirError.code !== "EEXIST") throw mkdirError;
        const concurrent = await fs.promises.lstat(next);
        if (!concurrent.isDirectory() || concurrent.isSymbolicLink()) throw new Error("file_sandbox_path_unsafe");
      }
    }
    parent = await fs.promises.realpath(next);
    if (!isContainedPath(root, parent) || isDeniedPath(parent, scope, true)) throw new Error("file_sandbox_permission_denied");
  }
  const absolutePath = path.join(parent, fileName);
  if (!isContainedPath(root, absolutePath) || isDeniedPath(absolutePath, scope, true)) throw new Error("file_sandbox_permission_denied");
  return { absolutePath };
}

async function readTextFile(absolutePath) {
  const initial = await fs.promises.lstat(absolutePath);
  if (!initial.isFile() || initial.isSymbolicLink() || initial.size > MAX_READ_FILE_BYTES) {
    throw new Error("file_sandbox_file_invalid");
  }
  const handle = await fs.promises.open(absolutePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  let body;
  let info;
  try {
    info = await handle.stat();
    body = await handle.readFile();
  } finally {
    await handle.close();
  }
  if (body.includes(0)) throw new Error("file_sandbox_content_unsupported");
  let text;
  const hasBom = body.length >= 3 && body[0] === 0xef && body[1] === 0xbb && body[2] === 0xbf;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(hasBom ? body.subarray(3) : body);
  } catch {
    throw new Error("file_sandbox_content_unsupported");
  }
  return { body, text, mode: info.mode & 0o777, hasBom, newline: text.includes("\r\n") ? "\r\n" : "\n" };
}

async function atomicReplace(absolutePath, body, mode, createOnly = false, requestId, expectedSha256) {
  const parent = path.dirname(absolutePath);
  const temporary = path.join(parent, `.${path.basename(absolutePath)}.codex-${crypto.randomBytes(12).toString("hex")}.tmp`);
  let created = false;
  let prepared;
  try {
    const handle = await fs.promises.open(temporary, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
    created = true;
    try {
      await handle.writeFile(body);
      await fs.promises.chmod(temporary, mode);
      await handle.sync();
      if (requestId) {
        const info = await handle.stat();
        prepared = { fileName: path.basename(temporary), sha256: sha256(body), sizeBytes: body.length,
          dev: info.dev, ino: info.ino, birthtimeMs: info.birthtimeMs, mtimeMs: info.mtimeMs, mode: info.mode & 0o777 };
      }
    } finally {
      await handle.close();
    }
    if (requestId) {
      const allowed = await new Promise((resolve) => {
        preparedAcks.set(requestId, resolve);
        const payload = Buffer.from(JSON.stringify({ requestId, ok: true, prepared }));
        const frame = Buffer.allocUnsafe(payload.length + 4);
        frame.writeUInt32BE(payload.length, 0);
        payload.copy(frame, 4);
        process.stdout.write(frame);
      });
      if (!allowed) throw new Error("file_sandbox_prepare_rejected");
      await verifyPreparedFile(temporary, prepared);
    }
    // Preparing and journaling must not turn a concurrent user edit into an overwrite.
    if (expectedSha256 && sha256((await readTextFile(absolutePath)).body) !== expectedSha256) {
      throw new Error("file_sandbox_content_conflict");
    }
    if (createOnly) {
      await fs.promises.link(temporary, absolutePath);
      await fs.promises.unlink(temporary);
    } else {
      await fs.promises.rename(temporary, absolutePath);
    }
  } catch (error) {
    if (created) {
      try {
        if (prepared) await verifyPreparedFile(temporary, prepared);
        await fs.promises.unlink(temporary);
      } catch { /* Unknown or changed artifacts must remain untouched. */ }
    }
    if (error && typeof error === "object" && error.code === "EEXIST") throw new Error("file_sandbox_file_exists");
    throw error;
  }
}

async function cleanupPrepared(operation) {
  const target = await resolveWritableTarget(operation.scopeRef, operation.relativePath, true);
  const prepared = operation.prepared;
  const prefix = `.${path.basename(target.absolutePath)}.codex-`;
  if (!prepared || typeof prepared.fileName !== "string" || !prepared.fileName.startsWith(prefix) ||
      !/^[a-f0-9]{24}\.tmp$/u.test(prepared.fileName.slice(prefix.length))) {
    throw new Error("file_sandbox_operation_invalid");
  }
  const temporary = path.join(path.dirname(target.absolutePath), prepared.fileName);
  try {
    await verifyPreparedFile(temporary, prepared);
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return { removed: false };
    throw error;
  }
  await fs.promises.unlink(temporary);
  return { removed: true };
}

async function verifyPreparedFile(temporary, prepared) {
  const info = await fs.promises.lstat(temporary);
  const sameIdentity = (value) => value.isFile() && !value.isSymbolicLink() && value.dev === prepared.dev &&
    value.ino === prepared.ino && value.birthtimeMs === prepared.birthtimeMs && value.mtimeMs === prepared.mtimeMs &&
    value.size === prepared.sizeBytes && (value.mode & 0o777) === prepared.mode;
  if (!sameIdentity(info) || info.size > MAX_READ_FILE_BYTES) throw new Error("file_sandbox_content_conflict");
  const handle = await fs.promises.open(temporary, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    if (!sameIdentity(await handle.stat()) || sha256(await handle.readFile()) !== prepared.sha256 ||
        !sameIdentity(await fs.promises.lstat(temporary))) throw new Error("file_sandbox_content_conflict");
  } finally {
    await handle.close();
  }
}

function normalizeNewlines(value, newline) {
  return value.replace(/\r\n|\r|\n/gu, newline);
}

async function mutationResult(absolutePath, body) {
  const info = await fs.promises.lstat(absolutePath);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("file_sandbox_file_invalid");
  return {
    sha256: sha256(body),
    sizeBytes: info.size,
    modifiedAt: info.mtimeMs,
    mode: info.mode & 0o777,
  };
}

function countOccurrences(value, needle) {
  let count = 0;
  let offset = 0;
  while (true) {
    const index = value.indexOf(needle, offset);
    if (index < 0) return count;
    count += 1;
    offset = index + needle.length;
  }
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function normalizeRelativePath(value) {
  const segments = value.replaceAll("\\", "/").split("/");
  if (segments.some((segment) => !safeEntryName(segment) || segment.length === 0)) {
    throw new Error("file_sandbox_operation_invalid");
  }
  return segments.join("/");
}

function isContainedPath(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function normalize(value, caseSensitive) {
  const normalized = value.normalize("NFKC");
  return caseSensitive ? normalized : normalized.toLocaleLowerCase();
}

function matchScore(name, relativePath, needle, match) {
  if (!needle) return 1;
  if (name === needle) return 500;
  if (name.includes(needle)) return 450;
  if (relativePath.includes(needle)) return 400;
  if (match !== "fuzzy") return 0;
  const terms = fuzzyTerms(needle);
  if (terms.length > 1 && terms.every((term) => name.includes(term))) return 350;
  if (terms.length > 1 && terms.every((term) => relativePath.includes(term))) return 300;
  if (terms.length > 1) {
    const nameMatches = terms.filter((term) => name.includes(term)).length;
    if (nameMatches > 0) return 200 + Math.round((nameMatches / terms.length) * 99);
    const pathMatches = terms.filter((term) => relativePath.includes(term)).length;
    if (pathMatches > 0) return 100 + Math.round((pathMatches / terms.length) * 99);
  }
  return 0;
}

function fuzzyTerms(value) {
  const terms = [];
  for (const segment of WORD_SEGMENTER.segment(value)) {
    if (!segment.isWordLike) continue;
    terms.push(...segment.segment.match(/\p{Letter}+|\p{Number}+/gu) ?? []);
  }
  return terms;
}

function matchesGlobs(relativePath, include, exclude, caseSensitive) {
  const included = !Array.isArray(include) || include.length === 0 ||
    include.some((glob) => globMatch(relativePath, glob, caseSensitive));
  return included && (!Array.isArray(exclude) || !exclude.some((glob) => globMatch(relativePath, glob, caseSensitive)));
}

function globMatch(value, glob, caseSensitive) {
  if (typeof glob !== "string" || glob.length < 1 || glob.length > 256) return false;
  const normalizedGlob = normalize(glob, caseSensitive);
  const normalizedValue = normalize(normalizedGlob.includes("/") ? value : path.posix.basename(value), caseSensitive);
  let expression = "";
  for (let index = 0; index < normalizedGlob.length; index += 1) {
    const character = normalizedGlob[index];
    if (character === "*" && normalizedGlob[index + 1] === "*") {
      if (normalizedGlob[index + 2] === "/") {
        expression += "(?:.*/)?";
        index += 2;
      } else {
        expression += ".*";
        index += 1;
      }
    } else if (character === "*") expression += "[^/]*";
    else if (character === "?") expression += "[^/]";
    else expression += character.replace(/[.+^${}()|[\]\\]/gu, "\\$&");
  }
  return new RegExp(`^${expression}$`, "u").test(normalizedValue);
}

function safeEntryName(value) {
  return value !== "." && value !== ".." && !Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint === 0 || codePoint <= 31 || codePoint === 127;
  });
}

function isApplePhotosLibrary(value) {
  return path.extname(value).toLocaleLowerCase("en-US") === ".photoslibrary";
}

function stableCompare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareScopeRefs(left, right) {
  return stableCompare(access.scopes.find((scope) => scope.scopeRef === left).scopeId,
    access.scopes.find((scope) => scope.scopeRef === right).scopeId);
}

function respond(requestId, ok, result, error) {
  const body = Buffer.from(JSON.stringify({ requestId, ok, ...(ok ? { result } : { error }) }), "utf8");
  if (body.length > MAX_FRAME_BYTES) {
    if (ok) return respond(requestId, false, undefined, "file_sandbox_result_too_large");
    process.exit(70);
  }
  const frame = Buffer.allocUnsafe(body.length + 4);
  frame.writeUInt32BE(body.length, 0);
  body.copy(frame, 4);
  process.stdout.write(frame);
}

function safeError(error) {
  if (error && typeof error === "object" && error.code === "ERR_ACCESS_DENIED") {
    return "file_sandbox_permission_denied";
  }
  if (error && typeof error === "object" && error.code === "ENOENT") return "file_sandbox_file_missing";
  const message = error instanceof Error ? error.message : "";
  return /^file_sandbox_[a-z0-9_]+$/u.test(message) ? message : "file_sandbox_operation_failed";
}
