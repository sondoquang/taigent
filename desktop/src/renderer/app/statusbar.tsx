import { useApp } from '@/store.ts';

/** The reviewer, the Taiga login and whether a taigent run goes on. */
export function Statusbar() {
  const reviewer = useApp((state) => state.view?.reviewer);
  const login = useApp((state) => state.login);
  const busy = useApp((state) => state.busy);
  const text = [
    reviewer ? `Người duyệt: ${reviewer}` : '',
    login ? (login.loggedIn ? `Taiga: ${login.username} @ ${login.apiUrl}` : (login.message ?? 'Chưa đăng nhập Taiga.')) : '',
    busy ? 'Đang chạy taigent…' : '',
  ]
    .filter(Boolean)
    .join('   ·   ');
  return (
    <footer id="statusbar" className="statusbar flex h-7 shrink-0 items-center truncate border-t bg-background px-3 text-xs whitespace-pre text-muted-foreground">
      {text}
    </footer>
  );
}
