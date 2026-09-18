import { apiV1BadRequest } from './api-key-auth'

/** Read a small public API body without buffering an unbounded request. */
export async function readBoundedJson(request: Request, maxBytes: number): Promise<unknown> {
  const declared = Number(request.headers.get('content-length'))
  if (declared > maxBytes) throw apiV1BadRequest('Request body is too large')
  if (!request.body) throw apiV1BadRequest('Invalid JSON body')

  const reader = request.body.getReader()
  const bytes = new Uint8Array(maxBytes)
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (size + value.byteLength > maxBytes) {
        await reader.cancel()
        throw apiV1BadRequest('Request body is too large')
      }
      bytes.set(value, size)
      size += value.byteLength
    }
  } finally {
    reader.releaseLock()
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size)))
  } catch {
    throw apiV1BadRequest('Invalid JSON body')
  }
}
