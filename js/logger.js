/**
 * logger.js — MediaVault Global Logger
 * File: js/logger.js
 *
 * Usato da TUTTI i moduli come: MV.log / MV.warn / MV.error / MV.group / MV.groupEnd
 * Formato output: [file.js][FunctionName] messaggio
 *
 * Palette colori DevTools:
 *   file=cyan, fn=viola, body=bianco
 *   warn=arancio, error=rosso, section=azzurro
 */

window.MV = (() => {
  const S = {
    file:    'color:#00f5d4;font-weight:bold',
    fn:      'color:#a78bfa;font-weight:bold',
    body:    'color:#e2e8f0',
    warn:    'color:#f59e0b;font-weight:bold',
    error:   'color:#ef4444;font-weight:bold',
    section: 'color:#38bdf8;font-weight:bold',
  };

  function log(file, fn, msg, data) {
    const p = `%c[${file}]%c[${fn}]%c `;
    if (data !== undefined) console.log(p + msg, S.file, S.fn, S.body, data);
    else                    console.log(p + msg, S.file, S.fn, S.body);
  }

  function warn(file, fn, msg, data) {
    const p = `%c[${file}][${fn}] ⚠ `;
    if (data !== undefined) console.warn(p + msg, S.warn, data);
    else                    console.warn(p + msg, S.warn);
  }

  function error(file, fn, msg, data) {
    const p = `%c[${file}][${fn}] ✗ `;
    if (data !== undefined) console.error(p + msg, S.error, data);
    else                    console.error(p + msg, S.error);
  }

  function group(file, fn, title) {
    console.group(`%c[${file}][${fn}] ▶ ${title}`, S.section);
  }

  function groupEnd() { console.groupEnd(); }

  function section(title) {
    console.groupCollapsed(`%c━━━━━━  ${title}  ━━━━━━`, S.section);
  }

  /** Legge le impostazioni proxy da localStorage senza dipendere da StorageManager */
  function getProxySettings() {
    try {
      const s = JSON.parse(localStorage.getItem('mediavault_settings') || '{}');
      return {
        useAlloriginsFallback: s.useAlloriginsFallback === true,
      };
    } catch { return { useAlloriginsFallback: false }; }
  }

  log('logger.js', 'init', '✓ MV Logger inizializzato — tutti i moduli usano MV.log/warn/error');

  return { log, warn, error, group, groupEnd, section, getProxySettings };
})();
