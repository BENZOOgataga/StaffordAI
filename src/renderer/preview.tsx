import { createRoot } from 'react-dom/client';
import './styles/globals.css';
import { Preview } from './components/preview/preview.tsx';

const host = document.getElementById('preview-root');
if (host) createRoot(host).render(<Preview />);
