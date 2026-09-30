import { finishFeishuLogin } from '@/lib/server/feishu-auth';

export async function GET(request: Request) {
  return finishFeishuLogin(request);
}
