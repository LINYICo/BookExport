const heading = document.querySelector('#book-title');
const progress = document.querySelector('#download-progress');
const status = document.querySelector('#status');
const button = document.querySelector('button');

function render({
    available = false, bookTitle, running = false, disabled = false,
    done = 0, total = 0, chapterProgress = false, message
} = {}) {
    heading.textContent = available && bookTitle ? bookTitle : 'Download a book';
    status.textContent = message || (available
        ? 'EPUB download from WeRead'
        : 'Open a book in the WeRead reader.');
    button.textContent = running ? (disabled ? 'Cancelling…' : 'Cancel download') : 'Download EPUB';
    button.disabled = !available || disabled;
    button.toggleAttribute('data-running', running);
    progress.hidden = !running;

    if (chapterProgress) {
        progress.max = total;
        progress.value = done;
    } else {
        progress.removeAttribute('value');
    }
}

try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id != null && tab.url?.startsWith('https://weread.qq.com/')) {
        const port = chrome.tabs.connect(tab.id, { name: 'book-download', frameId: 0 });
        port.onMessage.addListener(render);
        port.onDisconnect.addListener(() => {
            const error = chrome.runtime.lastError;
            render(error ? { message: 'Refresh the WeRead tab and reopen BookExport.' } : {});
        });
        button.addEventListener('click', () => port.postMessage('toggle-download'));
    } else {
        render();
    }
} catch {
    render({ message: 'Could not connect to the reader. Reopen BookExport and try again.' });
}
