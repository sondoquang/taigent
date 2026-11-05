// The Taiga login dialog and the logout confirmation. The password goes to Taiga once, through main, to get a
// token; the app never keeps it (the field is cleared after every attempt).

import { useEffect, useRef, useState } from 'react';
import { applyView, closeAccount, refreshLogin, toast } from '@/actions.ts';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog.tsx';
import { Button } from '@/components/ui/button.tsx';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog.tsx';
import { Field, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field.tsx';
import { Input } from '@/components/ui/input.tsx';
import { Spinner } from '@/components/ui/spinner.tsx';
import { api, useApp } from '@/store.ts';

function LoginDialog() {
  const open = useApp((state) => state.account === 'login');
  const savedUrl = useApp((state) => state.login?.apiUrl);
  const [url, setUrl] = useState('');
  const [user, setUser] = useState('');
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);
  const password = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setError(undefined);
    if (savedUrl) setUrl(savedUrl);
  }, [open, savedUrl]);

  async function submit(event: React.SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    const field = password.current;
    if (!field) return;
    setPending(true);
    const result = await api.login({ apiUrl: url, username: user, password: field.value });
    field.value = '';
    setPending(false);
    if (!result.ok) {
      setError(result.detail ? `${result.message} (${result.detail})` : result.message);
      return;
    }
    closeAccount();
    toast(`Đã đăng nhập: ${result.value.username}`);
    await refreshLogin();
    const view = useApp.getState().view;
    if (view) applyView(await api.openProject(view.slug));
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !next && closeAccount()}>
      <DialogContent id="login-dialog" className="sm:max-w-md">
        <form id="login-form" onSubmit={(event) => void submit(event)} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>Đăng nhập Taiga</DialogTitle>
            <DialogDescription>
              Mật khẩu chỉ gửi tới Taiga một lần để lấy token; ứng dụng không lưu mật khẩu. Token được cất trong kho thông tin đăng nhập của hệ
              điều hành, dùng chung với <code>taigent login</code>.
            </DialogDescription>
          </DialogHeader>
          <FieldGroup className="gap-4">
            <Field>
              <FieldLabel htmlFor="login-url">URL API Taiga</FieldLabel>
              <Input id="login-url" type="url" required placeholder="https://taiga.example.com/api/v1" value={url} onChange={(event) => setUrl(event.target.value)} />
            </Field>
            <Field>
              <FieldLabel htmlFor="login-user">Tên đăng nhập hoặc email</FieldLabel>
              <Input id="login-user" type="text" required autoComplete="username" value={user} onChange={(event) => setUser(event.target.value)} />
            </Field>
            <Field data-invalid={error ? true : undefined}>
              <FieldLabel htmlFor="login-password">Mật khẩu</FieldLabel>
              <Input id="login-password" ref={password} type="password" required autoComplete="current-password" aria-invalid={error ? true : undefined} />
              {error && (
                <FieldError id="login-error" className="error">
                  {error}
                </FieldError>
              )}
            </Field>
          </FieldGroup>
          <DialogFooter>
            <Button type="button" variant="outline" id="login-cancel" onClick={closeAccount}>
              Huỷ
            </Button>
            <Button type="submit" id="login-submit" disabled={pending}>
              {pending && <Spinner />}
              Đăng nhập
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function LogoutDialog() {
  const open = useApp((state) => state.account === 'logout');
  const login = useApp((state) => state.login);
  async function logout() {
    closeAccount();
    const result = await api.logout();
    if (!result.ok) toast(result.message, 'error');
    else toast('Đã đăng xuất.');
    await refreshLogin();
  }
  return (
    <AlertDialog open={open} onOpenChange={(next) => !next && closeAccount()}>
      <AlertDialogContent id="logout-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle>Đăng xuất Taiga?</AlertDialogTitle>
          <AlertDialogDescription>
            Đăng xuất {login?.username} khỏi {login?.apiUrl}?
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel id="logout-cancel">Huỷ</AlertDialogCancel>
          <AlertDialogAction id="logout-confirm" onClick={() => void logout()}>
            Đăng xuất
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export function AccountDialogs() {
  return (
    <>
      <LoginDialog />
      <LogoutDialog />
    </>
  );
}
