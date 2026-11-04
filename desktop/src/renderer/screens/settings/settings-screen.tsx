// The Settings section: the app's colours (Theo hệ thống, Sáng or Tối; the main process saves the choice and sets
// nativeTheme.themeSource, which drives `prefers-color-scheme` here and the title bar), the agent of the headless skill
// buttons, and the versions of the app and its parts.

import { useEffect, useState } from 'react';
import { THEMES, type Theme } from '../../../shared/api.ts';
import { chooseHeadlessAgent, toast } from '@/actions.ts';
import { Code, PageHeader, ScreenBody } from '@/components/common.tsx';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card.tsx';
import { Label } from '@/components/ui/label.tsx';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group.tsx';
import { Table, TableBody, TableCell, TableHead, TableRow } from '@/components/ui/table.tsx';
import { api, useApp } from '@/store.ts';

const THEME_OPTIONS: { value: Theme; label: string; toast: string }[] = [
  { value: 'system', label: 'Theo hệ thống', toast: 'theo hệ thống' },
  { value: 'light', label: 'Sáng', toast: 'sáng' },
  { value: 'dark', label: 'Tối', toast: 'tối' },
];

const AGENT_OPTIONS = [
  { value: 'omp', label: 'omp (OMP, oh-my-pi)' },
  { value: 'claude', label: 'claude (Claude Code)' },
  { value: 'codex', label: 'codex (Codex CLI)' },
];

function Choices({ id, label, value, options, onChange }: {
  id: string;
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
}) {
  return (
    <RadioGroup id={id} aria-label={label} value={value} onValueChange={onChange} className="gap-3">
      {options.map((option) => (
        <div key={option.value} className="flex items-center gap-2">
          <RadioGroupItem id={`${id}-${option.value}`} value={option.value} />
          <Label htmlFor={`${id}-${option.value}`} className="font-normal">
            {option.label}
          </Label>
        </div>
      ))}
    </RadioGroup>
  );
}

export function SettingsScreen() {
  const headlessAgent = useApp((s) => s.headlessAgent);
  const versions = useApp((s) => s.versions);
  const [theme, setTheme] = useState<Theme>();

  useEffect(() => void api.theme().then(setTheme), []);

  const chooseTheme = async (choice: string) => {
    const picked = THEMES.find((known) => known === choice);
    if (!picked) return;
    setTheme(picked);
    const result = await api.setTheme(picked);
    if (result.ok) {
      setTheme(result.value);
      toast(`Giao diện ${THEME_OPTIONS.find((option) => option.value === result.value)?.toast ?? result.value}.`);
    } else {
      toast([result.message, result.detail].filter(Boolean).join(': '), 'error');
      setTheme(await api.theme());
    }
  };

  const rows = versions ? { 'Taigent Desktop': versions.app, taigent: versions.taigent, Electron: versions.electron, Node: versions.node } : {};
  return (
    <ScreenBody>
      <PageHeader title="Settings" description="Đăng nhập hoặc đăng xuất Taiga bằng nút ở góc trên bên phải." />
      <div className="settings-grid grid items-start gap-6 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>
              <h2>Giao diện</h2>
            </CardTitle>
            <CardDescription>
              Màu của ứng dụng, mặc định là <b>Tối</b>. <b>Theo hệ thống</b> đổi theo chế độ sáng/tối của Windows hoặc macOS.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Choices id="settings-theme" label="Giao diện" value={theme ?? ''} options={THEME_OPTIONS} onChange={(value) => void chooseTheme(value)} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>
              <h2>Agent cho nút chạy skill</h2>
            </CardTitle>
            <CardDescription>
              Agent mà các nút <b>Plan backlog từ spec</b>, <b>Nhờ agent xử lý góp ý</b> và <b>Tạo user story</b> dùng (<Code>run-skill</Code>{' '}
              headless). Ứng dụng không cài hay đăng nhập agent giúp bạn.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Choices
              id="settings-agent"
              label="Agent cho nút chạy skill"
              value={headlessAgent}
              options={AGENT_OPTIONS}
              onChange={(value) => void chooseHeadlessAgent(value)}
            />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>
              <h2>Phiên bản</h2>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <Table id="settings-versions" className="versions">
              <TableBody>
                {Object.entries(rows).map(([name, value]) => (
                  <TableRow key={name}>
                    <TableHead className="text-muted-foreground">{name}</TableHead>
                    <TableCell className="">{value}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>
    </ScreenBody>
  );
}
