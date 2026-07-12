// history.js — reverse-chronological digest history + reopen tracking.

const $ = (id) => document.getElementById(id);
const els = {
  loading: $('loading'),
  empty: $('empty'),
  digestList: $('digest-list'),
};

function formatDate(iso) {
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function renderDigest(digest) {
  const li = document.createElement('li');
  li.className = 'digest';

  const header = document.createElement('div');
  header.className = 'digest-header';

  const date = document.createElement('span');
  date.className = 'digest-date';
  date.textContent = formatDate(digest.sentAt);

  const meta = document.createElement('span');
  meta.className = 'digest-meta';
  const count = digest.articles ?? digest.urls.length;
  meta.textContent = `${count} article${count === 1 ? '' : 's'} · ${digest.id}`;

  header.append(date, meta);

  const list = document.createElement('ul');
  list.className = 'article-list';
  for (const item of digest.urls) {
    const row = document.createElement('li');
    row.className = 'article-row';

    const link = document.createElement('a');
    link.className = 'article-title';
    link.href = item.url;
    link.target = '_blank';
    link.rel = 'noopener';
    link.textContent = item.title || item.url;
    row.appendChild(link);

    if (item.reopenedCount > 0) {
      const badge = document.createElement('span');
      badge.className = 'reopen-badge';
      badge.textContent = `↺ reopened ${item.reopenedCount}×`;
      row.appendChild(badge);
    }

    list.appendChild(row);
  }

  li.append(header, list);
  return li;
}

async function load() {
  const res = await chrome.runtime.sendMessage({ type: 'getHistory' });
  if (!res || !res.ok || !res.digests || res.digests.length === 0) {
    els.loading.hidden = true;
    els.empty.hidden = false;
    return;
  }
  els.loading.hidden = true;
  els.digestList.hidden = false;
  for (const digest of res.digests) {
    els.digestList.appendChild(renderDigest(digest));
  }
}

load();
