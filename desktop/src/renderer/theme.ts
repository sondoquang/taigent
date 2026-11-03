// The Settings choice of the app's colours: Theo hệ thống, Sáng or Tối. The main process saves it and sets
// nativeTheme.themeSource, which drives `prefers-color-scheme` here (the dark tokens of styles.css) and the title bar.

import { THEMES, type TaigentApi, type Theme } from '../shared/api.ts';

const LABELS: Record<Theme, string> = { system: 'theo hệ thống', light: 'sáng', dark: 'tối' };

function show(theme: Theme): void {
  for (const radio of document.querySelectorAll<HTMLInputElement>('input[name="theme"]')) radio.checked = radio.value === theme;
}

export function mountTheme(api: TaigentApi, toast: (message: string, kind?: 'info' | 'error') => void): void {
  for (const radio of document.querySelectorAll<HTMLInputElement>('input[name="theme"]')) {
    radio.addEventListener('change', async () => {
      const picked = THEMES.find((known) => known === radio.value);
      if (!picked) return;
      const result = await api.setTheme(picked);
      if (result.ok) {
        show(result.value);
        toast(`Giao diện ${LABELS[result.value]}.`);
      } else {
        toast([result.message, result.detail].filter(Boolean).join(': '), 'error');
        show(await api.theme());
      }
    });
  }
  void api.theme().then(show);
}
