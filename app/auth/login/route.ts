import { startFeishuLogin } from '@/lib/server/feishu-auth';

export function GET() {
  return startFeishuLogin();
}
