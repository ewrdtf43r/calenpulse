const $ = (selector) => document.querySelector(selector);

const state = { events: [], editing: null, settings: null };

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

function renderEvents() {
  const now = Date.now();
  const visible = state.events
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
    if (event.color) card.style.borderLeftColor = event.color;

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

    const open = () => openEditor(event);
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
    state.events = await send('events:list', {
      timeMin: new Date(now - 3_600_000).toISOString(),
      timeMax: new Date(now + 14 * 86_400_000).toISOString(),
    });
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

function toInputDate(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function toInputTime(date) {
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function nextSlot() {
  const start = new Date();
  start.setSeconds(0, 0);
  start.setMinutes(Math.ceil((start.getMinutes() + 1) / 30) * 30);
  const end = new Date(start.getTime() + 3_600_000);
  return { start, end };
}

function openEditor(event = null) {
  if (event && isAllDay(event)) {
    toast('События на весь день редактируются в Google Календаре');
    if (event.htmlLink) chrome.tabs.create({ url: event.htmlLink });
    return;
  }
  if (event && (event.accessRole === 'reader' || event.accessRole === 'freeBusyReader')) {
    toast('Календарь только для чтения — открываю событие в Google');
    if (event.htmlLink) chrome.tabs.create({ url: event.htmlLink });
    return;
  }

  state.editing = event ? { id: event.id, calendarId: event.calendarId } : null;
  $('#editor-title').textContent = event ? 'Событие' : 'Новое событие';
  $('#editor-delete').hidden = !event;
  $('#form-error').hidden = true;
  $('#editor-calendar').hidden = !event || event.primary;
  $('#editor-calendar').textContent = event && !event.primary ? `Календарь: ${event.calendarName}` : '';

  if (event) {
    const start = startDate(event);
    const end = endDate(event);
    $('#f-summary').value = event.summary;
    $('#f-date').value = toInputDate(start);
    $('#f-start').value = toInputTime(start);
    $('#f-end').value = toInputTime(end);
  } else {
    const { start, end } = nextSlot();
    $('#f-summary').value = '';
    $('#f-date').value = toInputDate(start);
    $('#f-start').value = toInputTime(start);
    $('#f-end').value = toInputTime(end);
  }
  $('#f-location').value = event?.location || '';
  $('#f-description').value = event?.description || '';

  $('#editor').showModal();
  if (!event) $('#f-summary').focus();
}

function closeEditor() {
  $('#editor').close();
  state.editing = null;
}

function formError(message) {
  const el = $('#form-error');
  el.textContent = message;
  el.hidden = false;
}

async function submitForm(e) {
  e.preventDefault();
  const summary = $('#f-summary').value.trim();
  const date = $('#f-date').value;
  const from = $('#f-start').value;
  const to = $('#f-end').value;

  if (!summary) return formError('Введите название события');
  if (!date || !from || !to) return formError('Заполните дату и время');

  const start = new Date(`${date}T${from}:00`);
  const end = new Date(`${date}T${to}:00`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return formError('Некорректная дата');
  if (end <= start) return formError('Конец должен быть позже начала');

  const payload = {
    summary,
    description: $('#f-description').value.trim(),
    location: $('#f-location').value.trim(),
    startISO: start.toISOString(),
    endISO: end.toISOString(),
    reminders: state.settings.reminders,
  };

  const saveButton = $('#editor-save');
  saveButton.disabled = true;
  try {
    if (state.editing) {
      await send('events:update', {
        id: state.editing.id,
        calendarId: state.editing.calendarId,
        ...payload,
      });
    } else {
      await send('events:create', payload);
    }
    closeEditor();
    toast('Сохранено в Google Календаре');
    await loadEvents();
  } catch (err) {
    formError(err.message);
  } finally {
    saveButton.disabled = false;
  }
}

async function deleteCurrent() {
  if (!state.editing) return;
  const summary = $('#f-summary').value.trim() || 'это событие';
  if (!confirm(`Удалить «${summary}»?`)) return;
  try {
    await send('events:delete', {
      id: state.editing.id,
      calendarId: state.editing.calendarId,
    });
    closeEditor();
    toast('Событие удалено');
    await loadEvents();
  } catch (err) {
    formError(err.message);
  }
}

async function connect() {
  const button = $('#connect');
  button.disabled = true;
  button.textContent = 'Открываю Google…';
  try {
    const result = await send('auth:connect');
    $('#account').textContent = result.label || '';
    if (result.syncError) toast(`Google подключён, но сервер: ${result.syncError}`);
    state.settings = await send('settings:get');
    await loadEvents();
  } catch (err) {
    const message = /only one web auth flow/i.test(err.message)
      ? 'Окно входа Google уже открыто. Закройте его и нажмите «Подключить Google» снова.'
      : err.message;
    showError(message);
  } finally {
    button.disabled = false;
    button.textContent = 'Подключить Google';
  }
}

async function init() {
  $('#refresh').addEventListener('click', () => loadEvents());
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
  $('#new-event').addEventListener('click', () => openEditor());
  $('#event-form').addEventListener('submit', submitForm);
  $('#editor-cancel').addEventListener('click', closeEditor);
  $('#editor-close').addEventListener('click', closeEditor);
  $('#editor-delete').addEventListener('click', deleteCurrent);
  $('#editor').addEventListener('click', (e) => {
    if (e.target === $('#editor')) closeEditor();
  });

  state.settings = await send('settings:get');
  const status = await send('auth:status');
  if (!status.connected) {
    showConnect();
    return;
  }
  $('#account').textContent = status.label || '';
  await loadEvents();

  setInterval(() => {
    if (!document.hidden) loadEvents();
  }, 120_000);
}

init().catch((e) => showError(e.message));
