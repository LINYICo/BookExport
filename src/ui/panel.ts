import css from './panel.css';

export function createDownloadPanel(onDownload: () => void) {
    const stylesheet = new CSSStyleSheet();
    stylesheet.replaceSync(css);

    const host = document.createElement('div');
    const root = host.attachShadow({ mode: 'closed' });
    root.adoptedStyleSheets = [stylesheet];
    root.innerHTML = `
        <main popover="auto" role="dialog" aria-label="BookExport">
            <header>
                <span class="product">BookExport</span>
                <button class="close" type="button" aria-label="Close popup" autofocus></button>
            </header>
            <div class="download">
                <div class="preview" aria-hidden="true">
                    <div class="ebook">EPUB</div>
                </div>
                <h1 id="book-title">Download a book</h1>
                <progress class="progress" aria-label="EPUB download progress" hidden></progress>
                <p id="status" role="status"></p>
                <button class="download-button" type="button" disabled>Download EPUB</button>
            </div>
        </main>
    `;

    const dialog = root.querySelector('main');
    const heading = root.querySelector('#book-title');
    const progress = root.querySelector('progress');
    const status = root.querySelector<HTMLParagraphElement>('#status');
    const button = root.querySelector<HTMLButtonElement>('.download-button');
    const closeButton = root.querySelector('.close');
    if (!dialog || !heading || !progress || !status || !button || !closeButton)
        throw new Error('Download panel is incomplete');

    document.documentElement.append(host);

    const close = () => dialog.hidePopover();
    const toggle = () => dialog.togglePopover();

    const render = ({
        available,
        bookTitle,
        running = false,
        disabled = false,
        done = 0,
        total = 0,
        chapterProgress = false,
        message,
    }: {
        available: boolean;
        bookTitle: string;
        running?: boolean;
        disabled?: boolean;
        done?: number;
        total?: number;
        chapterProgress?: boolean;
        message?: string;
    }) => {
        heading.textContent = available && bookTitle ? bookTitle : 'Download a book';
        status.textContent = message || (available ? '' : 'Open a book in the WeRead reader.');
        button.textContent = running
            ? disabled
                ? 'Cancelling…'
                : 'Cancel download'
            : 'Download EPUB';
        button.disabled = !available || disabled;
        button.toggleAttribute('data-running', running);
        progress.hidden = !running;

        if (chapterProgress) {
            progress.max = total;
            progress.value = done;
            progress.setAttribute('aria-valuetext', done + ' of ' + total + ' chapters');
        } else {
            progress.removeAttribute('value');
            progress.removeAttribute('aria-valuetext');
        }
    };

    closeButton.addEventListener('click', () => close());
    button.addEventListener('click', onDownload);
    return { close, render, toggle };
}
