import { createEventEditor } from './lib/event-editor.js';
import { canWrite, isVisible } from './lib/calendar.js';

const $ = (selector) => document.querySelector(selector);
const DAY_MS = 86_400_000;
const PX_PER_MIN = 0.8;

const state = {
  view: 'week',
  anchor: new Date(),
  events: [],
  calendars: [],
  writableCalendars: [],
  colors: { event: {} },
  hidden: new Set(),
  settings: null,
  needScroll: true,
  popoverEvent: null,
};

function send(type, data) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type, data }, (response) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (!response) return reject(new Error('Расширение не ответило — перезагрузите страницу'));
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

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function startOfDay(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

function startOfWeek(date) {
  const d = startOfDay(date);
  const offset = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - offset);
  return d;
}

function addDays(date, count) {
  const d = new Date(date);
  d.setDate(d.getDate() + count);
  return d;
}

function dayKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function eventStart(event) {
  return event.allDay ? new Date(`${event.start}T00:00:00`) : new Date(event.start);
}

function eventEnd(event) {
  return event.allDay ? new Date(`${event.end}T00:00:00`) : new Date(event.end);
}

function timeOf(iso) {
  return new Date(iso).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}

function capitalize(text) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function getRange() {
  if (state.view === 'month') {
    const first = new Date(state.anchor.getFullYear(), state.anchor.getMonth(), 1);
    const last = new Date(state.anchor.getFullYear(), state.anchor.getMonth() + 1, 0);
    return { start: startOfWeek(first), end: addDays(startOfWeek(last), 7) };
  }
  const days = state.view === '2weeks' ? 14 : 7;
  const start = startOfWeek(state.anchor);
  return { start, end: addDays(start, days) };
}

function daysBetween(start, end) {
  const days = [];
  for (let d = new Date(start); d < end; d = addDays(d, 1)) days.push(new Date(d));
  return days;
}

function rangeLabel(days) {
  const first = days[0];
  const last = days[days.length - 1];
  const monthYear = (date) =>
    new Intl.DateTimeFormat('ru-RU', { month: 'long', year: 'numeric' })
      .format(date)
      .replace(/\s*г\.$/, '');
  const monthDay = (date) =>
    new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long' }).format(date);

  if (state.view === 'month') {
    const monthStart = new Date(state.anchor.getFullYear(), state.anchor.getMonth(), 1);
    return capitalize(monthYear(monthStart));
  }

  const sameMonth = first.getMonth() === last.getMonth() && first.getFullYear() === last.getFullYear();
  if (sameMonth) return `${first.getDate()}–${monthDay(last)} ${last.getFullYear()}`;
  if (first.getFullYear() === last.getFullYear()) {
    return `${monthDay(first)} – ${monthDay(last)} ${last.getFullYear()}`;
  }
  return `${monthDay(first)} ${first.getFullYear()} – ${monthDay(last)} ${last.getFullYear()}`;
}

function eventsOnDay(day) {
  const dayStart = startOfDay(day).getTime();
  const dayEnd = dayStart + DAY_MS;
  return state.events.filter((event) => {
    if (state.hidden.has(event.calendarId)) return false;
    const start = eventStart(event).getTime();
    const end = eventEnd(event).getTime();
    return start < dayEnd && end > dayStart;
  });
}

function applyColors(node, event) {
  const calColor = event.color || '#7c8cff';
  node.style.setProperty('--cal-color', calColor);
  node.style.setProperty('--event-color', state.colors.event?.[event.colorId]?.background || calColor);
}

function openInGoogle(event) {
  if (event.htmlLink) {
    chrome.tabs.create({ url: event.htmlLink });
    return;
  }
  toast('У этого события нет ссылки на Google Календарь');
}

function describeWhen(event) {
  const start = eventStart(event);
  const date = new Intl.DateTimeFormat('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' }).format(start);
  const clock = (date2) => date2.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  const time = event.allDay ? 'весь день' : `${clock(start)}–${clock(eventEnd(event))}`;
  return `${capitalize(date)} · ${time}`;
}

function positionPopover(anchor) {
  const pop = $('#event-popover');
  const rect = anchor.getBoundingClientRect();
  const pad = 12;
  const width = pop.offsetWidth;
  const height = pop.offsetHeight;

  let left = rect.right + 10;
  if (left + width > innerWidth - pad) left = rect.left - width - 10;
  if (left < pad) left = Math.max(pad, Math.min(rect.left, innerWidth - width - pad));

  let top = rect.top;
  if (top + height > innerHeight - pad) top = innerHeight - height - pad;
  if (top < pad) top = pad;

  pop.style.left = `${Math.round(left)}px`;
  pop.style.top = `${Math.round(top)}px`;
}

function closeRename() {
  $('#popover-input').hidden = true;
  $('#popover-title').hidden = false;
}

function closePopover() {
  state.popoverEvent = null;
  closeRename();
  $('#event-popover').hidden = true;
}

function openPopover(event, anchor) {
  state.popoverEvent = event;
  const pop = $('#event-popover');
  pop.style.setProperty('--cal-color', event.color || '#7c8cff');

  $('#popover-title').textContent = event.summary;
  closeRename();

  $('#popover-when').textContent = describeWhen(event);

  const calendarLine = $('#popover-calendar');
  calendarLine.hidden = !event.calendarName;
  calendarLine.replaceChildren();
  const dot = el('span', 'dot');
  dot.style.background = event.color || '#7c8cff';
  calendarLine.append(dot, el('span', '', event.calendarName || ''));

  const where = $('#popover-where');
  where.hidden = !event.location;
  where.textContent = event.location || '';

  const notes = $('#popover-notes');
  const description = (event.description || '').trim();
  notes.hidden = !description;
  notes.textContent = description;

  const writable = canWrite(event.accessRole);
  $('#popover-title').disabled = !writable;
  $('#popover-title').title = writable ? 'Нажмите, чтобы переименовать' : 'Календарь только для чтения';
  $('#popover-edit').hidden = !writable || event.allDay;
  $('#popover-delete').hidden = !writable;
  $('#popover-google').hidden = !event.htmlLink;

  pop.hidden = false;
  positionPopover(anchor);
}

async function renameFromPopover() {
  const event = state.popoverEvent;
  const input = $('#popover-input');
  if (!event || input.hidden) return;

  const summary = input.value.trim();
  closeRename();
  if (!summary || summary === event.summary) return;

  try {
    await send('events:update', {
      id: event.id,
      calendarId: event.calendarId,
      summary,
      description: event.description || '',
      location: event.location || '',
      startISO: event.start,
      endISO: event.end,
      allDay: event.allDay,
      reminders: state.settings.reminders,
    });
    toast('Название обновлено');
    closePopover();
    await load();
  } catch (e) {
    toast(`Не удалось переименовать: ${e.message}`);
  }
}

function startRename() {
  const event = state.popoverEvent;
  if (!event || $('#popover-title').disabled) return;
  const input = $('#popover-input');
  input.value = event.summary;
  $('#popover-title').hidden = true;
  input.hidden = false;
  input.focus();
  input.select();
}

async function deleteFromPopover() {
  const event = state.popoverEvent;
  if (!event) return;
  if (!confirm(`Удалить «${event.summary}»?`)) return;
  try {
    await send('events:delete', { id: event.id, calendarId: event.calendarId });
    closePopover();
    toast('Событие удалено');
    await load();
  } catch (e) {
    toast(`Не удалось удалить: ${e.message}`);
  }
}

const editor = createEventEditor({
  send,
  toast,
  getCalendars: () => state.writableCalendars,
  getSettings: () => state.settings,
  onSaved: () => load(),
  openExternal: openInGoogle,
});

function renderFilters() {
  const bar = $('#filter-bar');
  if (state.calendars.length < 2) {
    bar.hidden = true;
    bar.replaceChildren();
    return;
  }
  bar.hidden = false;
  const scrollLeft = bar.scrollLeft;
  bar.replaceChildren();
  bar.scrollLeft = scrollLeft;

  const anyHidden = state.calendars.some((cal) => state.hidden.has(cal.id));
  const all = el('button', `filter-chip all${anyHidden ? '' : ' active'}`, 'Все');
  all.type = 'button';
  all.addEventListener('click', () => {
    state.hidden.clear();
    persistFilters();
    renderFilters();
    render();
  });
  bar.append(all);

  for (const cal of state.calendars) {
    const visible = !state.hidden.has(cal.id);
    const chip = el('button', `filter-chip${visible ? ' active' : ''}`);
    chip.type = 'button';
    chip.title = visible ? `Скрыть «${cal.summary}»` : `Показать «${cal.summary}»`;
    chip.setAttribute('aria-pressed', String(visible));

    const dot = el('span', 'dot');
    dot.style.background = cal.color;
    chip.append(dot, el('span', '', cal.summary));
    chip.addEventListener('click', () => {
      if (state.hidden.has(cal.id)) state.hidden.delete(cal.id);
      else state.hidden.add(cal.id);
      persistFilters();
      renderFilters();
      render();
    });
    bar.append(chip);
  }
}

let filterTimer;
function persistFilters() {
  state.settings.hiddenCalendars = [...state.hidden];
  clearTimeout(filterTimer);
  filterTimer = setTimeout(() => {
    send('settings:save', { hiddenCalendars: [...state.hidden] }).catch(() => {});
  }, 250);
}

function layoutLanes(items) {
  items.sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start));
  let active = [];
  let cluster = [];

  const flush = () => {
    if (!cluster.length) return;
    const lanes = Math.max(...cluster.map((item) => item.lane + 1));
    for (const item of cluster) item.lanes = lanes;
    cluster = [];
  };

  for (const item of items) {
    active = active.filter((other) => other.end > item.start);
    if (!active.length) flush();
    let lane = 0;
    while (active.some((other) => other.lane === lane)) lane += 1;
    item.lane = lane;
    active.push(item);
    cluster.push(item);
  }
  flush();
  return items;
}

function makeTimedEvent(item, dayStartMs) {
  const { event, start, end, lane, lanes } = item;
  const node = el('div', 'gevent');
  node.style.top = `${((start - dayStartMs) / 60_000) * PX_PER_MIN}px`;
  node.style.height = `${Math.max(((end - start) / 60_000) * PX_PER_MIN, 17)}px`;
  if (lanes > 1) {
    node.style.left = `calc(${(lane / lanes) * 100}% + 2px)`;
    node.style.right = 'auto';
    node.style.width = `calc(${100 / lanes}% - 4px)`;
  }
  applyColors(node, event);
  node.append(el('span', 'gt', event.summary));
  if ((end - start) / 60_000 >= 30) {
    node.append(el('span', 'gm', `${timeOf(event.start)}–${timeOf(event.end)}`));
  }
  node.title = [
    `${timeOf(event.start)}–${timeOf(event.end)}`,
    event.summary,
    event.primary ? '' : event.calendarName,
  ].filter(Boolean).join(' · ');
  node.addEventListener('click', (e) => {
    e.stopPropagation();
    openPopover(event, node);
  });
  return node;
}

function makeAllDayEvent(event) {
  const node = el('div', 'gevent');
  applyColors(node, event);
  node.append(el('span', 'gt', event.summary));
  node.title = [event.summary, event.primary ? '' : event.calendarName].filter(Boolean).join(' · ');
  node.addEventListener('click', (e) => {
    e.stopPropagation();
    openPopover(event, node);
  });
  return node;
}

function renderWeek(days) {
  const todayKey = dayKey(new Date());
  const columns = `56px repeat(${days.length}, minmax(0, 1fr))`;
  const view = el('div', 'week-view');
  view.style.minWidth = `${56 + days.length * 76}px`;

  const head = el('div', 'week-head');
  head.style.gridTemplateColumns = columns;
  head.append(el('div', 'corner'));
  for (const day of days) {
    const cell = el('div', `day-head${dayKey(day) === todayKey ? ' today' : ''}`);
    cell.append(
      el('span', 'dow', day.toLocaleDateString('ru-RU', { weekday: 'short' })),
      el('span', 'num', String(day.getDate()))
    );
    head.append(cell);
  }

  const allday = el('div', 'allday-row');
  allday.style.gridTemplateColumns = columns;
  allday.append(el('div', 'allday-label', 'весь день'));
  for (const day of days) {
    const cell = el('div', 'allday-cell');
    const items = eventsOnDay(day).filter((event) => event.allDay);
    for (const event of items) cell.append(makeAllDayEvent(event));
    allday.append(cell);
  }

  const body = el('div', 'week-body');
  body.style.gridTemplateColumns = columns;

  const axis = el('div', 'time-axis');
  for (let hour = 0; hour < 24; hour += 1) {
    const label = el('div', 'time-label');
    label.append(el('span', '', `${String(hour).padStart(2, '0')}:00`));
    axis.append(label);
  }
  body.append(axis);

  for (const day of days) {
    const column = el('div', 'day-col');
    column.dataset.day = String(startOfDay(day).getTime());
    column.style.height = `${24 * 60 * PX_PER_MIN}px`;
    const dayStart = startOfDay(day).getTime();
    const dayEnd = dayStart + DAY_MS;

    const items = eventsOnDay(day)
      .filter((event) => !event.allDay)
      .map((event) => ({
        event,
        start: Math.max(eventStart(event).getTime(), dayStart),
        end: Math.min(eventEnd(event).getTime(), dayEnd),
      }))
      .filter((item) => item.end > item.start);

    for (const item of layoutLanes(items)) column.append(makeTimedEvent(item, dayStart));

    if (dayKey(day) === todayKey) {
      const now = Date.now();
      if (now >= dayStart && now < dayEnd) {
        const line = el('div', 'now-line');
        line.style.top = `${((now - dayStart) / 60_000) * PX_PER_MIN}px`;
        column.append(line);
      }
    }

    body.append(column);
  }

  view.append(head, allday, body);
  return view;
}

function makeMonthChip(event) {
  const chip = el('div', 'mchip');
  applyColors(chip, event);
  if (!event.allDay) chip.append(el('span', 'mt', timeOf(event.start)));
  chip.append(el('span', 'mn', event.summary));
  chip.title = [
    event.allDay ? 'весь день' : `${timeOf(event.start)}–${timeOf(event.end)}`,
    event.summary,
    event.primary ? '' : event.calendarName,
  ].filter(Boolean).join(' · ');
  chip.addEventListener('click', (e) => {
    e.stopPropagation();
    openPopover(event, chip);
  });
  return chip;
}

function renderMonth(days) {
  const todayKey = dayKey(new Date());
  const month = state.anchor.getMonth();
  const view = el('div', 'month-view');

  for (const name of ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс']) {
    view.append(el('div', 'month-head', name));
  }

  for (const day of days) {
    const classes = ['mday'];
    if (day.getMonth() !== month) classes.push('other');
    if (dayKey(day) === todayKey) classes.push('today');
    const cell = el('div', classes.join(' '));
    cell.dataset.day = String(startOfDay(day).getTime());

    const head = el('div', 'mday-head');
    head.append(el('span', 'mday-num', String(day.getDate())));
    cell.append(head);

    const events = eventsOnDay(day).sort((a, b) => {
      if (a.allDay !== b.allDay) return a.allDay ? -1 : 1;
      return eventStart(a) - eventStart(b);
    });
    const limit = 3;
    for (const event of events.slice(0, limit)) cell.append(makeMonthChip(event));
    if (events.length > limit) cell.append(el('div', 'mmore', `ещё ${events.length - limit}`));

    view.append(cell);
  }
  return view;
}

function render() {
  closePopover();
  const range = getRange();
  const days = daysBetween(range.start, range.end);
  $('#range').textContent = rangeLabel(days);
  for (const button of document.querySelectorAll('#views button')) {
    button.classList.toggle('active', button.dataset.view === state.view);
  }

  const grid = $('#grid');
  grid.hidden = false;
  grid.classList.remove('dim');
  $('#error-state').hidden = true;
  grid.replaceChildren(state.view === 'month' ? renderMonth(days) : renderWeek(days));

  if (state.needScroll) {
    state.needScroll = false;
    const main = $('#main');
    requestAnimationFrame(() => {
      main.scrollTop = state.view === 'month' ? 0 : 8 * 48 - 90;
    });
  }
}

async function load() {
  const range = getRange();
  $('#range').textContent = rangeLabel(daysBetween(range.start, range.end));
  const grid = $('#grid');
  if (!grid.hidden) grid.classList.add('dim');

  try {
    const [calendars, events, colors] = await Promise.all([
      send('calendars:list'),
      send('events:list', {
        timeMin: range.start.toISOString(),
        timeMax: range.end.toISOString(),
      }),
      send('colors:get').catch(() => ({ event: {} })),
    ]);
    state.calendars = calendars.filter((cal) => cal.selected && isVisible(cal.accessRole));
    state.writableCalendars = calendars.filter((cal) => canWrite(cal.accessRole));
    state.events = events;
    state.colors = colors || { event: {} };
    renderFilters();
    render();
  } catch (e) {
    grid.classList.remove('dim');
    const message = /не подключён|refresh token|credential/i.test(e.message)
      ? 'Google Календарь не подключён. Подключите его в боковой панели CalenPulse.'
      : e.message;
    $('#error-text').textContent = message;
    $('#error-state').hidden = false;
    grid.hidden = true;
  }
}

function navigate(direction) {
  const anchor = new Date(state.anchor);
  if (state.view === 'month') anchor.setMonth(anchor.getMonth() + direction);
  else anchor.setDate(anchor.getDate() + direction * (state.view === '2weeks' ? 14 : 7));
  state.anchor = anchor;
  load();
}

function formatMinutes(minutes) {
  return `${String(Math.floor(minutes / 60) % 24).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

function slotForDay(day) {
  const start = startOfDay(day);
  const now = new Date();
  if (dayKey(now) === dayKey(day)) {
    start.setSeconds(0, 0);
    start.setMinutes(Math.ceil((now.getMinutes() + 1) / 30) * 30);
  } else {
    start.setHours(9, 0, 0, 0);
  }
  return { start, end: new Date(start.getTime() + 3_600_000) };
}

let drag = null;

function dragMinutes(column, clientY) {
  const rect = column.getBoundingClientRect();
  const minutes = (clientY - rect.top) / PX_PER_MIN;
  return Math.max(0, Math.min(1440, Math.round(minutes / 15) * 15));
}

function dragBounds() {
  const from = Math.min(drag.startMin, drag.currentMin);
  const to = Math.min(Math.max(drag.startMin, drag.currentMin, from + 15), 1440);
  return { from, to };
}

function updateGhost() {
  const { from, to } = dragBounds();
  drag.ghost.style.top = `${from * PX_PER_MIN}px`;
  drag.ghost.style.height = `${Math.max((to - from) * PX_PER_MIN, 15)}px`;
  drag.ghost.textContent = `${formatMinutes(from)} – ${formatMinutes(to)}`;
}

document.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || state.view === 'month') return;
  const column = e.target.closest('.day-col');
  if (!column || e.target.closest('.gevent')) return;

  e.preventDefault();
  closePopover();

  const startMin = dragMinutes(column, e.clientY);
  const ghost = el('div', 'drag-ghost');
  column.append(ghost);
  drag = { column, startMin, currentMin: startMin, ghost, moved: false };
  updateGhost();
});

document.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const minutes = dragMinutes(drag.column, e.clientY);
  if (minutes !== drag.currentMin) drag.moved = true;
  drag.currentMin = minutes;
  updateGhost();
});

document.addEventListener('pointerup', () => {
  if (!drag) return;
  const { column, startMin, currentMin, moved, ghost } = drag;
  drag = null;
  ghost.remove();

  const from = Math.min(startMin, currentMin);
  const to = moved ? Math.min(Math.max(startMin, currentMin), 1440) : Math.min(from + 30, 1440);
  if (to - from < 15) return;

  const dayStart = Number(column.dataset.day);
  editor.open(null, {
    start: new Date(dayStart + from * 60_000),
    end: new Date(dayStart + Math.max(to, from + 15) * 60_000),
  });
});

document.addEventListener('pointercancel', () => {
  if (!drag) return;
  drag.ghost.remove();
  drag = null;
});

document.addEventListener('click', (e) => {
  const cell = e.target.closest('.mday');
  if (!cell || e.target.closest('.mchip, .mmore')) return;
  closePopover();
  editor.open(null, slotForDay(new Date(Number(cell.dataset.day))));
});

async function init() {
  const savedView = localStorage.getItem('calenpulse.view');
  if (['2weeks', 'week', 'month'].includes(savedView)) state.view = savedView;

  for (const button of document.querySelectorAll('#views button')) {
    button.addEventListener('click', () => {
      state.view = button.dataset.view;
      state.needScroll = true;
      localStorage.setItem('calenpulse.view', state.view);
      load();
    });
  }

  $('#prev').addEventListener('click', () => navigate(-1));
  $('#next').addEventListener('click', () => navigate(1));
  $('#today').addEventListener('click', () => {
    state.anchor = new Date();
    state.needScroll = true;
    load();
  });
  $('#refresh').addEventListener('click', () => load());
  $('#retry').addEventListener('click', () => load());

  $('#popover-close').addEventListener('click', closePopover);
  $('#popover-title').addEventListener('click', startRename);
  $('#popover-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      renameFromPopover();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closeRename();
    }
  });
  $('#popover-input').addEventListener('blur', () => renameFromPopover());
  $('#popover-edit').addEventListener('click', () => {
    const event = state.popoverEvent;
    closePopover();
    if (event) editor.open(event);
  });
  $('#popover-delete').addEventListener('click', deleteFromPopover);
  $('#popover-google').addEventListener('click', () => {
    if (state.popoverEvent) openInGoogle(state.popoverEvent);
  });

  document.addEventListener('pointerdown', (e) => {
    if ($('#event-popover').hidden) return;
    if (e.target.closest('#event-popover, .gevent, .mchip')) return;
    closePopover();
  });

  $('#main').addEventListener('scroll', () => {
    if (!$('#event-popover').hidden) closePopover();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closePopover();
      return;
    }
    if (e.target.closest('input, textarea, select')) return;
    if (e.key === 'ArrowLeft') navigate(-1);
    else if (e.key === 'ArrowRight') navigate(1);
    else if (e.key === 't') {
      state.anchor = new Date();
      state.needScroll = true;
      load();
    }
  });

  state.settings = await send('settings:get');
  state.hidden = new Set(state.settings.hiddenCalendars || []);
  await load();

  setInterval(() => {
    if (!document.hidden) load();
  }, 120_000);
}

init().catch((e) => {
  $('#error-text').textContent = e.message;
  $('#error-state').hidden = false;
});
