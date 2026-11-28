import type { ExportView } from '../export.ts';
import teko from './fonts/teko-bookexport.woff2';
import css from './panel.css';

export function createDownloadPanel(onDownload: () => void) {
    const stylesheet = new CSSStyleSheet();
    stylesheet.replaceSync(css);
    const font = new FontFace('BookExport Teko', Uint8Array.fromBase64(teko), {
        weight: '600',
        display: 'swap',
    });
    document.fonts.add(font);

    const host = document.createElement('div');
    const root = host.attachShadow({ mode: 'closed' });
    root.adoptedStyleSheets = [stylesheet];
    root.innerHTML = `
        <main popover="auto" role="dialog" aria-label="BookExport" data-stage="idle">
            <header>
                <span class="product">BookExport</span>
                <button class="close" type="button" aria-label="Close popup" autofocus></button>
            </header>
            <div class="download">
                <div class="preview" aria-hidden="true">
                    <div class="ebook">EPUB</div>
                </div>
                <h1 id="book-title">Download a book</h1>
                <div class="progress-track" hidden>
                    <span class="progress-fill" aria-hidden="true"></span>
                    <progress class="visually-hidden" aria-label="EPUB download progress"></progress>
                </div>
                <p id="status" class="visually-hidden" role="status"></p>
                <button class="download-button" type="button" disabled>Download EPUB</button>
                <p class="download-result" hidden>Export complete</p>
                <p class="resource-warning" hidden></p>
            </div>
        </main>
    `;

    const dialog = root.querySelector('main');
    const heading = root.querySelector('#book-title');
    const track = root.querySelector<HTMLElement>('.progress-track');
    const progress = root.querySelector('progress');
    const status = root.querySelector('#status');
    const button = root.querySelector<HTMLButtonElement>('.download-button');
    const result = root.querySelector<HTMLElement>('.download-result');
    const warning = root.querySelector<HTMLElement>('.resource-warning');
    const closeButton = root.querySelector<HTMLButtonElement>('.close');
    if (
        !dialog ||
        !heading ||
        !track ||
        !progress ||
        !status ||
        !button ||
        !result ||
        !warning ||
        !closeButton
    )
        throw new Error('Download panel is incomplete');

    document.documentElement.append(host);

    let completionSeen = false;
    const close = () => dialog.hidePopover();
    const toggle = () => {
        dialog.togglePopover();
        return dialog.matches(':popover-open') && completionSeen;
    };

    const render = ({
        available,
        bookTitle,
        stage = 'idle',
        running = false,
        disabled = false,
        done = 0,
        total = 0,
        message = '',
        warning: warningText = '',
    }: { available: boolean; bookTitle: string } & Partial<ExportView>) => {
        const completed = stage === 'completed';
        const failed = stage === 'failed';
        const indeterminate = stage === 'preparing' || stage === 'images' || stage === 'packaging';
        completionSeen = completed && (completionSeen || dialog.matches(':popover-open'));
        const title = available && bookTitle ? bookTitle : 'Download a book';
        if (heading.textContent !== title) heading.textContent = title;
        if (dialog.dataset.stage !== stage) dialog.dataset.stage = stage;

        const announcement = message || (available ? '' : 'Open a book in the WeRead reader.');
        if (status.textContent !== announcement) status.textContent = announcement;
        const label =
            stage === 'cancelling'
                ? 'Cancelling…'
                : running
                  ? 'Cancel download'
                  : failed
                    ? 'Retry download'
                    : 'Download EPUB';
        if (button.textContent !== label) button.textContent = label;
        const restoreFocus = completed && root.activeElement === button;
        button.hidden = completed;
        button.disabled = !available || disabled;
        button.toggleAttribute('data-running', running);
        button.title = failed ? message : '';
        if (failed) button.setAttribute('aria-describedby', 'status');
        else button.removeAttribute('aria-describedby');
        result.hidden = !completed;
        if (restoreFocus) closeButton.focus();
        if (warning.textContent !== warningText) warning.textContent = warningText;
        warning.hidden = !warningText;

        track.hidden = !running && !failed && !completed;
        track.classList.toggle('indeterminate', indeterminate);
        const max = total || 1;
        const value = completed ? max : done;
        const fraction = String(value / max);
        if (track.style.getPropertyValue('--progress') !== fraction)
            track.style.setProperty('--progress', fraction);
        if (indeterminate) {
            progress.removeAttribute('value');
            progress.removeAttribute('aria-valuetext');
        } else {
            if (progress.max !== max) progress.max = max;
            if (!progress.hasAttribute('value') || progress.value !== value) progress.value = value;
            const text = failed
                ? 'Export failed'
                : completed
                  ? 'Export complete'
                  : total
                    ? done + ' of ' + total + ' chapters'
                    : '';
            if (text) progress.setAttribute('aria-valuetext', text);
            else progress.removeAttribute('aria-valuetext');
        }
    };

    closeButton.addEventListener('click', close);
    button.addEventListener('click', onDownload);
    return { close, render, toggle };
}
