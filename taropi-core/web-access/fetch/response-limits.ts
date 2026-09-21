// 响应体大小与文本类型判定：为文本读取施加字节上限，避免超大响应占满内存。
export function isTextContentType(contentType: string): boolean {
  const type = contentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return type.startsWith("text/") || type === "application/json" || type === "application/xml" || type.endsWith("+json") || type.endsWith("+xml") || type === "";
}

/** readResponseBufferWithLimit 读取响应体为 ArrayBuffer，超出 maxBytes 直接报错并终止读取 */
export async function readResponseBufferWithLimit(response: Response, maxBytes: number): Promise<ArrayBuffer> {
  if (!response.body) return response.arrayBuffer();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new Error(`Response too large (>${Math.round(maxBytes / 1024 / 1024)}MB)`);
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const buffer = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return buffer.buffer;
}

/** readTextResponseWithLimit 读取响应体为文本，超出上限直接报错 */
export async function readTextResponseWithLimit(response: Response, maxBytes: number): Promise<string> {
  const buffer = await readResponseBufferWithLimit(response, maxBytes);
  return new TextDecoder("utf-8").decode(buffer);
}
