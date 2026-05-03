export type ExtensionDialogRequest = {
  sessionId: string;
  id: string;
  method: string;
  title: string;
  message?: string;
  options?: string[];
  placeholder?: string;
  prefill?: string;
  promptStyle?: boolean;
  timeoutMs?: number;
  targetId?: string;
  notifyType?: string;
  statusText?: string;
  widgetLines?: string[];
  text?: string;
};

export function parseExtensionDialogRequest(sessionId: string, dialog: unknown): ExtensionDialogRequest | null {
  if (!isRecord(dialog)) return null;
  const id = stringField(dialog, "id");
  const method = stringField(dialog, "method");
  if (!id || !method) return null;

  return {
    sessionId,
    id,
    method,
    title: stringField(dialog, "title") ?? extensionDialogFallbackTitle(method),
    message: stringField(dialog, "message"),
    options: stringArrayField(dialog, "options"),
    placeholder: stringField(dialog, "placeholder"),
    prefill: stringField(dialog, "prefill"),
    promptStyle: booleanField(dialog, "promptStyle"),
    timeoutMs: numberField(dialog, "timeout"),
    targetId: stringField(dialog, "targetId"),
    notifyType: stringField(dialog, "notifyType"),
    statusText: stringField(dialog, "statusText"),
    widgetLines: stringArrayField(dialog, "widgetLines"),
    text: stringField(dialog, "text"),
  };
}

export function extensionDialogFallbackTitle(method: string): string {
  switch (method) {
    case "confirm":
      return "Confirm action";
    case "select":
      return "Choose an option";
    case "input":
      return "Input requested";
    case "editor":
      return "Edit response";
    case "notify":
      return "Extension notice";
    default:
      return "Extension request";
  }
}

export function extensionDialogBodyText(request: ExtensionDialogRequest): string {
  if (request.message) return request.message;
  if (request.method === "editor" && request.promptStyle) return "The extension requested a prompt-style editor response.";
  if (request.method === "setWidget" && request.widgetLines?.length) return request.widgetLines.join("\n");
  return "";
}

export function formatExtensionDialogNotification(request: ExtensionDialogRequest): string {
  const prefix = request.notifyType ? `${request.notifyType}: ` : "";
  return `${prefix}${request.message ?? request.title}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function booleanField(record: Record<string, unknown>, key: string): boolean | undefined {
  const value = record[key];
  return typeof value === "boolean" ? value : undefined;
}

function numberField(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function stringArrayField(record: Record<string, unknown>, key: string): string[] | undefined {
  const value = record[key];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : undefined;
}
