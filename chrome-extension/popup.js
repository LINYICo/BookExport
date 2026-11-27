export async function createDownloadPanel({ onDownload }) {
    const response = await fetch(chrome.runtime.getURL('popup.css'));
    if (!response.ok) throw new Error('Could not load the download panel stylesheet');
    const stylesheet = new CSSStyleSheet();
    stylesheet.replaceSync(await response.text());

    const host = document.createElement('div');
    host.hidden = true;
    const root = host.attachShadow({ mode: 'closed' });
    root.adoptedStyleSheets = [stylesheet];
    root.innerHTML = `
        <main role="dialog" aria-label="BookExport">
            <header>
                <span class="product">BookExport</span>
                <button class="close" type="button" aria-label="Close popup"></button>
            </header>
            <div class="download">
                <div class="preview" aria-hidden="true">
                    <div class="ebook">EPUB</div>
                </div>
                <h1 id="book-title">Download a book</h1>
                <div class="progress" role="progressbar" aria-label="EPUB download progress" hidden>
                    <div class="progress-fill"></div>
                </div>
                <p id="status" role="status"></p>
                <button class="download-button" type="button" disabled>Download EPUB</button>
            </div>
        </main>
    `;

    const heading = root.querySelector('#book-title');
    const progress = root.querySelector('.progress');
    const status = root.querySelector('#status');
    const button = root.querySelector('.download-button');
    const closeButton = root.querySelector('.close');
    let previousFocus;

    document.documentElement.append(host);

    function close(restoreFocus = true) {
        if (host.hidden) return;
        host.hidden = true;
        window.removeEventListener('pointerdown', dismissOutside, true);
        window.removeEventListener('keydown', dismissWithEscape, true);
        if (restoreFocus && previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
    }

    function dismissOutside(event) {
        if (!event.composedPath().includes(host)) close(false);
    }

    function dismissWithEscape(event) {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        event.stopImmediatePropagation();
        close();
    }

    function toggle() {
        if (!host.hidden) {
            close();
            return;
        }
        previousFocus = document.activeElement;
        host.hidden = false;
        closeButton.focus({ preventScroll: true });
        window.addEventListener('pointerdown', dismissOutside, true);
        window.addEventListener('keydown', dismissWithEscape, true);
    }

    function render({
        available, bookTitle, running = false, disabled = false,
        done = 0, total = 0, chapterProgress = false, message
    }) {
        heading.textContent = available && bookTitle ? bookTitle : 'Download a book';
        status.textContent = message || (available ? '' : 'Open a book in the WeRead reader.');
        button.textContent = running ? (disabled ? 'Cancelling…' : 'Cancel download') : 'Download EPUB';
        button.disabled = !available || disabled;
        button.toggleAttribute('data-running', running);
        progress.hidden = !running;

        if (chapterProgress) {
            const percent = Math.round(done / total * 100);
            progress.setAttribute('aria-valuenow', String(percent));
            progress.setAttribute('aria-valuetext', done + ' of ' + total + ' chapters');
            progress.style.setProperty('--completion', done / total);
        } else {
            progress.removeAttribute('aria-valuenow');
            progress.removeAttribute('aria-valuetext');
            progress.style.removeProperty('--completion');
        }
    }

    closeButton.addEventListener('click', () => close());
    button.addEventListener('click', onDownload);
    return { close, render, toggle };
}
