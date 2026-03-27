import type { MessageInstance } from "antd/es/message/interface";

let messageApi: MessageInstance | null = null;

export function setMessageApi(api: MessageInstance): void {
  messageApi = api;
}

export function toast(): MessageInstance {
  if (!messageApi) {
    throw new Error("message api is not ready");
  }

  return messageApi;
}
