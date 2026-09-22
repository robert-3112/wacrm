import { beforeEach, describe, expect, it, vi } from 'vitest'
import { __resetRateLimitForTests } from '@/lib/rate-limit'
const mocks = vi.hoisted(() => ({ access: vi.fn(), window: vi.fn() }))
vi.mock('@/lib/whatsapp-oficial/api-auth', async () => ({
  ...await vi.importActual('@/lib/whatsapp-oficial/api-auth'), requireConversationAccess: mocks.access,
}))
vi.mock('@/lib/whatsapp-oficial/conversation-window', () => ({ readConversationWindow: mocks.window }))
import { NotFoundError, UnauthorizedError } from '@/lib/whatsapp-oficial/api-auth'
import { GET } from './route'
const id = '10000000-0000-4000-8000-000000000001'
const request = () => new Request(`http://localhost/api/whatsapp-oficial/messages/window?conversationId=${id}`)
beforeEach(() => { vi.resetAllMocks(); __resetRateLimitForTests() })
describe('conversation window access', () => {
  it.each([new UnauthorizedError(), new NotFoundError('hidden')])('does not read window before session/RLS authorization',async (error) => {
    mocks.access.mockRejectedValue(error)
    expect((await GET(request())).status).toBe(error.status)
    expect(mocks.window).not.toHaveBeenCalled()
  })
  it('returns authoritative window without cache and with scoped conversation',async () => {
    const conversation = {id,tenant_id:'tenant',canal_id:'channel'}
    const admin = {}
    mocks.access.mockResolvedValue({userId:'operator',conversation,admin})
    mocks.window.mockResolvedValue({applies:true,open:false,expiresAt:null,serverTime:'2026-09-22T12:00:00Z'})
    const response = await GET(request())
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toContain('no-store')
    expect(mocks.window).toHaveBeenCalledWith(admin,conversation)
    expect(await response.json()).toMatchObject({open:false})
  })
  it('does not report closed/open if the lookup fails',async () => {
    mocks.access.mockResolvedValue({userId:'operator',conversation:{id},admin:{}})
    mocks.window.mockRejectedValue(new Error('db'))
    expect((await GET(request())).status).toBe(500)
  })
})
