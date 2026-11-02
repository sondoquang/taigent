// The Wiki section: wiki pages of docs.yaml read and written through the manifest edit API (src/edit.ts), and
// "Đẩy wiki lên Taiga": `upload --dry-run --json`, a native dialog listing what would be created, updated and
// skipped, then `upload --yes --json` only after the user confirms. Wiki pages are not reviewed (no review.yaml).

import { type BrowserWindow, dialog } from 'electron';
import type { Failure, Result, SaveWikiPageRequest, UploadOperation, UploadPlan, UploadReport, WikiSaveOutcome, WikiSnapshot, WikiUploadOutcome } from '../shared/api.ts';
import { failure, serialized, toFailure } from './project.ts';
import { projectDir } from './repo.ts';
import { type CliError, loadCore, parseCliJson, runCli } from './taigent.ts';

export async function readWiki(root: string, slug: string): Promise<Result<WikiSnapshot>> {
  const { edit } = await loadCore();
  try {
    return { ok: true, value: await edit.readWikiPages(projectDir(root, slug)) };
  } catch (error) {
    return toFailure(error, 'Không đọc được docs.yaml');
  }
}

export function saveWikiPage(root: string, slug: string, request: SaveWikiPageRequest): Promise<Result<WikiSaveOutcome>> {
  return serialized(async () => {
    const { edit } = await loadCore();
    try {
      const result = await edit.saveWikiPage(projectDir(root, slug), request);
      if (result.status !== 'saved') return { ok: true, value: result };
      return { ok: true, value: { ...result, wiki: await readWiki(root, slug) } };
    } catch (error) {
      return toFailure(error, 'Không lưu được trang wiki');
    }
  });
}

/** One line of the confirm dialog for an upload operation. */
function describe(operation: UploadOperation): string {
  if (operation.type === 'wiki') return `Trang wiki ${operation.slug} (${operation.file})`;
  const previous = operation.action === 'create' && operation.previous.length > 0 ? `; ${operation.previous.length} bản cũ cùng tên vẫn giữ trên Taiga` : '';
  return `Tệp đính kèm ${operation.name} → ${operation.target}${previous}`;
}

const ACTION_TITLE: Record<UploadOperation['action'], string> = { create: 'Tạo mới', update: 'Cập nhật', skip: 'Bỏ qua (đã khớp với Taiga)' };

function confirmDetail(slug: string, plan: UploadPlan): string {
  const lines = [`Dự án: ${slug}`];
  for (const action of ['create', 'update', 'skip'] as const) {
    const operations = plan.operations.filter((operation) => operation.action === action);
    lines.push('', `${ACTION_TITLE[action]}: ${operations.length}`, ...operations.map((operation) => `  • ${describe(operation)}`));
  }
  lines.push('', 'Wiki không qua review. Tệp đính kèm chỉ được thêm, không bao giờ bị xoá hay thay.');
  return lines.join('\n');
}

/** A failed `upload` run as a message in Vietnamese saying how to fix it; `detail` keeps the CLI's own text. */
function uploadFailure(step: 'dry-run' | 'yes', error: CliError | undefined): Failure {
  const extra = { detail: error?.message, issues: error?.issues };
  const kept = step === 'yes' ? ' Những gì đã ghi lên Taiga được giữ và lần chạy sau sẽ bỏ qua.' : ' Chưa ghi gì lên Taiga.';
  switch (error?.kind) {
    case 'conflict':
      return failure(
        `Có người vừa sửa ${error.key ?? 'trang wiki'} trên Taiga trong lúc đẩy, nên trang đó không bị ghi đè.${kept} Cách sửa: mở trang trên Taiga, chép phần cần giữ vào file Markdown trong mục Wiki, rồi bấm "Đẩy wiki lên Taiga" lại.`,
        extra,
      );
    case 'validation':
      return failure(`docs.yaml chưa hợp lệ.${kept} Cách sửa: sửa các lỗi dưới đây (slug, đường dẫn file) trong mục Wiki hoặc nhờ agent, rồi đẩy lại.`, extra);
    case 'login':
      return failure(`Chưa đăng nhập Taiga.${kept} Cách sửa: bấm "Đăng nhập" ở góc trên bên phải, rồi đẩy lại.`, extra);
    case 'usage':
      return failure(`taigent từ chối lệnh upload.${kept} Cách sửa: xem chi tiết dưới đây; nếu cần đăng nhập, bấm "Đăng nhập" ở góc trên bên phải.`, extra);
    case 'taiga':
      if (error.file) {
        return failure(`Taiga từ chối tệp ${error.file} vì quá lớn.${kept} Cách sửa: thu nhỏ tệp hoặc nhờ quản trị Taiga tăng giới hạn upload, rồi đẩy lại.`, extra);
      }
      if (error.status === 401 || error.status === 403) {
        return failure(`Taiga từ chối đăng nhập hoặc bạn không có quyền trên dự án.${kept} Cách sửa: đăng nhập lại (nút góc trên bên phải) bằng tài khoản là thành viên dự án, rồi đẩy lại.`, extra);
      }
      return failure(
        `Taiga báo lỗi khi đẩy wiki.${kept} Cách sửa: kiểm tra kết nối, dự án đã có trên Taiga, và các item mà tệp đính kèm trỏ tới đã được đẩy (Thay đổi → Đẩy lên Taiga); rồi đẩy lại.`,
        extra,
      );
    default:
      return failure(`Không chạy được taigent upload.${kept} Cách sửa: xem chi tiết dưới đây, rồi thử lại.`, extra);
  }
}

/** "Đẩy wiki lên Taiga": dry run, then a confirm dialog listing create, update and skip, then `upload --yes`. */
export async function uploadWiki(root: string, slug: string, window: BrowserWindow): Promise<Result<WikiUploadOutcome>> {
  const dryRun = await runCli(['upload', '--project', slug, '--dry-run', '--json'], root);
  const planned = parseCliJson<UploadPlan>(dryRun);
  if (!planned.value || (dryRun.code !== 0 && dryRun.code !== 3)) return uploadFailure('dry-run', planned.error);
  const plan = planned.value;
  if (!plan.changes) return { ok: true, value: { status: 'no-changes', plan } };

  const { response } = await dialog.showMessageBox(window, {
    type: 'question',
    title: 'Đẩy wiki lên Taiga',
    message: `Ghi wiki lên Taiga? Tạo mới ${plan.summary.create}, cập nhật ${plan.summary.update}, bỏ qua ${plan.summary.skip}.`,
    detail: confirmDetail(slug, plan),
    buttons: ['Đẩy wiki lên Taiga', 'Huỷ'],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  });
  if (response !== 0) return { ok: true, value: { status: 'cancelled', plan } };

  const run = await runCli(['upload', '--project', slug, '--yes', '--json'], root);
  const uploaded = parseCliJson<UploadReport>(run);
  if (uploaded.value && run.code === 0) return { ok: true, value: { status: 'uploaded', report: uploaded.value } };
  return uploadFailure('yes', uploaded.error);
}
