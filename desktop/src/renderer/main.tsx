import { createRoot } from 'react-dom/client';
import { App } from '@/app/app.tsx';

const root = document.getElementById('root');
if (!root) throw new Error('missing #root');
createRoot(root).render(<App />);
