// The CLI's Taiga errors as the Taiga screens (Project, Ticket của tôi, Báo cáo) say them: in Vietnamese, with how
// to fix them. The CLI's own message stays in the Failure's detail.

import type { Failure } from '../shared/api.ts';
import { failure } from './project.ts';
import type { CliError } from './taigent.ts';

export interface TaigaFailureText {
  /** What failed, with how to fix it, for any error but the login ones. */
  failed: string;
  /** The button that tries again on the screen. */
  retry?: string;
  /** Follows the first sentence of the login errors, e.g. " Chưa ghi gì lên Taiga." for a write. */
  nothing?: string;
}

/** "Cách sửa: kiểm tra mạng…": the fix of an error that is neither the login nor a known refusal. */
export function networkFix(retry = 'Làm mới'): string {
  return `Cách sửa: kiểm tra mạng và URL API Taiga, rồi bấm ${retry}.`;
}

/** A failed read or write of Taiga: not logged in, a login Taiga refuses (expired, or wrong TAIGA_* in .env), else `failed`. */
export function taigaFailure(error: CliError | undefined, { failed, retry = 'Làm mới', nothing = '' }: TaigaFailureText): Failure {
  const detail = error?.message;
  if (error?.kind === 'login') {
    return failure(`Chưa đăng nhập Taiga.${nothing} Cách sửa: bấm “Đăng nhập” ở cuối thanh bên trái (hoặc chạy npx taigent login trong terminal), rồi bấm ${retry}.`, {
      detail,
    });
  }
  if (error?.kind === 'taiga' && (error.status === 401 || (detail !== undefined && /taigent login|TAIGA_TOKEN|TAIGA_USERNAME/.test(detail)))) {
    return failure(
      `Đăng nhập Taiga đã hết hạn hoặc bị từ chối.${nothing} Cách sửa: bấm tên của bạn → Đăng xuất, rồi Đăng nhập lại ` +
        '(đăng nhập hết hạn sau 8 ngày không dùng); nếu repo đặt TAIGA_TOKEN hoặc TAIGA_USERNAME/TAIGA_PASSWORD (.env) thì sửa các biến đó.',
      { detail },
    );
  }
  return failure(failed, { detail });
}
