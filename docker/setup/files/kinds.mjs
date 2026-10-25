import path from 'node:path';
import { isSecret } from './paths.mjs';
const images = new Set(['png','jpg','jpeg','gif','webp','svg','ico','avif','bmp','heic']);
const code = new Set(['js','mjs','cjs','jsx','ts','tsx','json','jsonc','html','css','scss','less','py','go','rs','java','kt','sh','bash','zsh','toml','yaml','yml','xml','sql','rb','php','c','h','cpp','cs','vue','svelte','lock','env','tf','ex','exs','dart','zig','swift','fish','graphql','gql','proto','lua']);
const text = new Set(['txt','md','mdx','log','csv','tsv','conf','ini','properties','gitignore','gitattributes','editorconfig','rst','adoc']);
const names = { js: 'JavaScript', mjs: 'JavaScript', cjs: 'JavaScript', ts: 'TypeScript', tsx: 'TypeScript', md: 'Markdown', py: 'Python', rs: 'Rust', json: 'JSON', yaml: 'YAML', yml: 'YAML', svg: 'SVG image', pdf: 'PDF', zip: 'ZIP archive' };
export function kindOf(name, stat) {
  if (stat?.isSymbolicLink()) return 'link';
  if (stat?.isDirectory()) return 'folder';
  if (stat && !stat.isFile()) return 'special';
  if (isSecret(name)) return 'secret';
  const ext = path.extname(name).slice(1).toLowerCase() || name.replace(/^\./,'').toLowerCase();
  if (['mp4','mov','webm','mkv','avi'].includes(ext)) return 'video';
  if (['mp3','wav','m4a','flac','ogg'].includes(ext)) return 'audio';
  if (['sqlite','sqlite3','db'].includes(ext) || /(?:\.sqlite\d*|\.db)-(?:wal|shm)$/.test(name)) return 'db';
  if (images.has(ext)) return 'image';
  if (ext === 'pdf') return 'pdf';
  if (['zip','tar','gz','tgz','7z','rar','bz2','xz','pack'].includes(ext)) return 'archive';
  if (code.has(ext) || /^(Dockerfile|Makefile|\.env(?:\.|$))/.test(name)) return 'code';
  if (text.has(ext) || /^(LICENSE|NOTICE|README|CHANGELOG)(\.|$)/i.test(name)) return 'text';
  if (stat?.mode & 0o111 || /^\.(?:bashrc|zshrc|profile)$/.test(name)) return 'exec';
  return 'file';
}
export function typeOf(name, kind) {
  const ext = path.extname(name).slice(1).toLowerCase();
  return names[ext] || ({ folder:'Folder',link:'Symbolic link',image:ext.toUpperCase()+' image',archive:'Archive',text:'Text',code:'Code',pdf:'PDF',special:'Special file' })[kind] || (ext ? ext.toUpperCase()+' file' : 'File');
}
export const previewOf = (kind, bytes) => kind === 'image' ? bytes <= 25*1024*1024 ? 'image' : null : kind === 'pdf' ? bytes <= 50*1024*1024 ? 'pdf' : null : ['folder','link','special','archive','video','audio','db'].includes(kind) ? null : 'text';
