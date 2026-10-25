/**
 * A resource reload request. Tool callers receive scheduled before its own turn can finish.
 */
export interface ReloadOperation {
  id: string;
  status: "scheduled" | "completed" | "failed" | "interrupted" | "not-needed";
  error?: string;
  completed: Promise<void>;
}
