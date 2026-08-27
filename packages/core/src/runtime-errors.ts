import type { ConversationPersistenceOperation } from "./runtime-contracts.js";

export class ConversationPersistenceError extends Error {
  readonly operation: ConversationPersistenceOperation;

  constructor(
    operation: ConversationPersistenceOperation,
    message = "Conversation persistence failed."
  ) {
    super(message);
    this.name = "ConversationPersistenceError";
    this.operation = operation;
  }
}

export class AssistantTurnConflictError extends Error {
  readonly idempotencyKey: string;

  constructor(
    idempotencyKey: string,
    message = "Assistant turn idempotency key is already claimed."
  ) {
    super(message);
    this.name = "AssistantTurnConflictError";
    this.idempotencyKey = idempotencyKey;
  }
}
