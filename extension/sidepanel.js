import { createEventEditor } from './lib/event-editor.js';

const $ = (selector) => document.querySelector(selector);

const state = {
  events: [],
  calendars: [],
  writableCalendars: [],
  colors: { event: {} },
  hiddenCalendars: new Set(),
  settings: null,
};

function send(type, data) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type, data }, (response) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (!response) return reject(new Error('Расширение не ответило — перезагрузите панель'));
      if (response.ok) resolve(response.data);
      else reject(new Error(response.error));
    });
  });
}

let toastTimer;
function toast(message) {
  const el = $('#toast');
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2600);
}

function isAllDay(event) {
  return event.allDay === true || /^\d{4}-\d{2}-\d{2}$/.test(event.start || '');
}

function startDate(event) {
  return isAllDay(event) ? new Date(`${event.start}T00:00:00`) : new Date(event.start);
}

function endDate(event) {
  return isAllDay(event) ? new Date(`${event.end}T00:00:00`) : new Date(event.end);
}

function timeOf(iso) {
  return new Date(iso).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}

function dayKey(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function dayLabel(date) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const target = new Date(date);
  target.setHours(0, 0, 0, 0);
  const diffDays = Math.round((target - today) / 86_400_000);
  const formatted = date.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
  if (diffDays === 0) return `Сегодня, ${formatted}`;
  if (diffDays === 1) return `Завтра, ${formatted}`;
  const weekday = date.toLocaleDateString('ru-RU', { weekday: 'long' });
  return `${weekday.charAt(0).toUpperCase()}${weekday.slice(1)}, ${formatted}`;
}

function relativeToStart(startMs) {
  const diff = startMs - Date.now();
  if (diff <= 0) return 'уже идёт';
  const minutes = Math.round(diff / 60_000);
  if (minutes < 60) return `через ${minutes} мин`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours < 24) return rest ? `через ${hours} ч ${rest} мин` : `через ${hours} ч`;
  return `через ${Math.round(hours / 24)} дн`;
}

function showState(name) {
  for (const id of ['connect-state', 'loading', 'error-state', 'next-card', 'empty']) {
    $(`#${id}`).hidden = id !== name;
  }
  if (name !== 'events') $('#events').replaceChildren();
}

function showError(message) {
  $('#error-text').textContent = message;
  showState('error-state');
}

const CONNECT_TEXT = 'События будут в боковой панели, а напоминания — в браузере, Telegram и Discord.';

function showConnect(message) {
  $('#connect-text').textContent = message || CONNECT_TEXT;
  showState('connect-state');
}

function renderFilters() {
  const bar = $('#filter-bar');
  const calendars = state.calendars;
  if (calendars.length < 2) {
    bar.hidden = true;
    bar.replaceChildren();
    return;
  }
  bar.hidden = false;
  const scrollLeft = bar.scrollLeft;
  bar.replaceChildren();
  bar.scrollLeft = scrollLeft;

  const anyHidden = calendars.some((cal) => state.hiddenCalendars.has(cal.id));
  const all = document.createElement('button');
  all.type = 'button';
  all.className = `filter-chip all${anyHidden ? '' : ' active'}`;
  all.textContent = 'Все';
  all.addEventListener('click', () => {
    state.hiddenCalendars.clear();
    persistFilters();
    renderFilters();
    renderEvents();
  });
  bar.append(all);

  for (const cal of calendars) {
    const visible = !state.hiddenCalendars.has(cal.id);
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = `filter-chip${visible ? ' active' : ''}`;
    chip.title = visible ? `Скрыть «${cal.summary}»` : `Показать «${cal.summary}»`;
    chip.setAttribute('aria-pressed', String(visible));

    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.style.background = cal.color;

    const label = document.createElement('span');
    label.textContent = cal.summary;

    chip.append(dot, label);
    chip.addEventListener('click', () => {
      if (state.hiddenCalendars.has(cal.id)) state.hiddenCalendars.delete(cal.id);
      else state.hiddenCalendars.add(cal.id);
      persistFilters();
      renderFilters();
      renderEvents();
    });
    bar.append(chip);
  }
}

let filterSaveTimer;
function persistFilters() {
  state.settings.hiddenCalendars = [...state.hiddenCalendars];
  clearTimeout(filterSaveTimer);
  filterSaveTimer = setTimeout(() => {
    send('settings:save', { hiddenCalendars: [...state.hiddenCalendars] }).catch(() => {});
  }, 250);
}

function renderEvents() {
  const now = Date.now();
  const filtered = state.events.filter((event) => !state.hiddenCalendars.has(event.calendarId));
  const visible = filtered
    .filter((event) => endDate(event).getTime() > now - 300_000)
    .sort((a, b) => startDate(a) - startDate(b));

  const next = visible.find((event) => startDate(event).getTime() >= now - 300_000);

  const nextCard = $('#next-card');
  if (next) {
    nextCard.hidden = false;
    $('#next-title').textContent = next.summary;
    const when = isAllDay(next)
      ? `${dayLabel(startDate(next))} · весь день`
      : `${relativeToStart(startDate(next).getTime())} · ${timeOf(next.start)}–${timeOf(next.end)}`;
    const nextBits = [when];
    if (!next.primary) nextBits.push(next.calendarName);
    if (next.location) nextBits.push(next.location);
    $('#next-meta').textContent = nextBits.filter(Boolean).join(' · ');
  } else {
    nextCard.hidden = true;
  }

  const container = $('#events');
  container.replaceChildren();

  if (!visible.length) {
    const filteredOut = state.events.length > 0;
    $('#empty-title').textContent = filteredOut
      ? 'Все календари скрыты фильтром'
      : 'На ближайшие две недели событий нет.';
    $('#empty-text').textContent = filteredOut
      ? 'Нажмите «Все» или включите нужный календарь в фильтре выше.'
      : 'Создайте первое — оно сразу появится в Google Календаре.';
    showState('empty');
    return;
  }
  $('#empty').hidden = true;
  $('#loading').hidden = true;
  $('#error-state').hidden = true;

  let currentKey = '';
  for (const event of visible) {
    const date = startDate(event);
    const key = dayKey(date);
    if (key !== currentKey) {
      currentKey = key;
      const label = document.createElement('div');
      label.className = 'day-label';
      label.textContent = dayLabel(date);
      container.append(label);
    }

    const card = document.createElement('article');
    card.className = `event${isAllDay(event) ? ' all-day' : ''}`;
    card.tabIndex = 0;
    const calColor = event.color || '#7c8cff';
    card.style.setProperty('--cal-color', calColor);
    card.style.setProperty('--event-color', state.colors.event?.[event.colorId]?.background || calColor);

    const time = document.createElement('div');
    time.className = 'event-time';
    if (isAllDay(event)) {
      time.textContent = 'весь день';
    } else {
      time.textContent = timeOf(event.start);
      const end = document.createElement('span');
      end.className = 'end';
      end.textContent = timeOf(event.end);
      time.append(end);
    }

    const body = document.createElement('div');
    body.className = 'event-body';

    const title = document.createElement('h3');
    title.className = 'event-title';
    title.textContent = event.summary;

    const meta = document.createElement('p');
    meta.className = 'event-meta';
    const bits = [];
    if (!event.primary) bits.push(event.calendarName);
    if (event.location) bits.push(event.location);
    else if (event.description) bits.push(event.description.replace(/\s+/g, ' '));
    meta.textContent = bits.join(' · ');
    if (!event.primary) {
      const dot = document.createElement('span');
      dot.className = 'event-dot';
      dot.style.background = event.color || 'var(--accent)';
      meta.prepend(dot);
    }

    body.append(title);
    if (bits.length) body.append(meta);
    card.append(time, body);

    const open = () => editor.open(event);
    card.addEventListener('click', open);
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        open();
      }
    });
    container.append(card);
  }
}

async function loadEvents() {
  if (!state.settings) return;
  showState('loading');
  try {
    const now = Date.now();
    const [calendars, events, colors] = await Promise.all([
      send('calendars:list'),
      send('events:list', {
        timeMin: new Date(now - 3_600_000).toISOString(),
        timeMax: new Date(now + 14 * 86_400_000).toISOString(),
      }),
      send('colors:get').catch(() => ({ event: {} })),
    ]);
    state.calendars = calendars.filter((cal) => cal.selected && cal.accessRole !== 'freeBusyReader');
    state.writableCalendars = calendars.filter(
      (cal) => cal.accessRole === 'owner' || cal.accessRole === 'writer'
    );
    state.events = events;
    state.colors = colors || { event: {} };
    renderFilters();
    renderEvents();
  } catch (e) {
    if (/не подключён|refresh token|credential/i.test(e.message)) {
      showConnect();
    } else if (/insufficient|forbidden|403|scope/i.test(e.message)) {
      showConnect(
        'Google не выдал доступ к списку календарей. Нажмите «Подключить Google» — Google попросит подтвердить новый доступ.'
      );
    } else {
      showError(e.message);
    }
  }
}

const editor = createEventEditor({
  send,
  toast,
  getCalendars: () => state.writableCalendars,
  getSettings: () => state.settings,
  onSaved: () => loadEvents(),
  openExternal: (event) => chrome.tabs.create({ url: event.htmlLink }),
});

async function connect() {
  const button = $('#connect');
  button.disabled = true;
  button.textContent = 'Открываю Google…';
  try {
    const result = await send('auth:connect');
    $('#account').textContent = result.email || result.label || '';
    if (result.syncError) toast(`Google подключён, но сервер: ${result.syncError}`);
    state.settings = await send('settings:get');
    state.hiddenCalendars = new Set(state.settings.hiddenCalendars || []);
    await loadEvents();
  } catch (err) {
    const message = /only one web auth flow/i.test(err.message)
      ? 'Окно входа Google уже открыто. Закройте его и нажмите «Подключить Google» снова.'
      : /client_secret is missing/i.test(err.message)
        ? 'Client secret не сохранён. Откройте настройки → OAuth-клиент, вставьте секрет, нажмите «Сохранить» и повторите вход.'
        : err.message;
    showError(message);
  } finally {
    button.disabled = false;
    button.textContent = 'Подключить Google';
  }
}

async function init() {
  $('#refresh').addEventListener('click', () => loadEvents());
  $('#open-grid').addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('calendar.html') });
  });
  $('#settings').addEventListener('click', () => chrome.runtime.openOptionsPage());
  $('#retry').addEventListener('click', async () => {
    const status = await send('auth:status').catch(() => ({ connected: false }));
    if (!status.connected) {
      showConnect();
      return;
    }
    loadEvents();
  });
  $('#connect').addEventListener('click', connect);
  $('#new-event').addEventListener('click', () => editor.open());

  state.settings = await send('settings:get');
  state.hiddenCalendars = new Set(state.settings.hiddenCalendars || []);
  const status = await send('auth:status');
  if (!status.connected) {
    showConnect();
    return;
  }
  $('#account').textContent = status.email || status.label || '';
  await loadEvents();

  setInterval(() => {
    if (!document.hidden) loadEvents();
  }, 120_000);
}

init().catch((e) => showError(e.message));
