export type ReminderIntent = {
  accountId: string; target: string; eventKey: string; originalText: string; sourceText: string;
};

export type OwnedReminderIntent = ReminderIntent & { owner: string };

export interface MemoryReminderAdmission {
  reserve(owner: string): boolean;
  rollback(rollbackMemory: () => void): void;
}

export interface ReminderIntentOwnership {
  memoryAdmission(intents: OwnedReminderIntent[]): MemoryReminderAdmission;
}
