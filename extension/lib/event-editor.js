import { canWrite } from './calendar.js';
import { createDateField } from './date-field.js';

const $ = (selector) => document.querySelector(selector);

function isAllDay(event) {
  return event.allDay === true || /^\d{4}-\d{2}-\d{2}$/.test(event.start || '');
}

function startDate(event) {
  return isAllDay(event) ? new Date(`${event.start}T00:00:00`) : new Date(event.start);
}

function endDate(event) {
  return isAllDay(event) ? new Date(`${event.end}T00:00:00`) : new Date(event.end);
}

function toInputTime(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

const pad2 = (n) => String(n).padStart(2, '0');

// Время набираем сами: у <input type="time"> формат (AM/PM или 24ч) берётся из локали
// браузера, а не страницы, и переключить его средствами HTML нельзя.
function parseTime(raw) {
  const digits = String(raw).replace(/\D/g, '').slice(0, 4);
  if (!digits) return null;
  const hours = digits.length <= 2 ? Number(digits) : Number(digits.slice(0, -2));
  const minutes = digits.length <= 2 ? 0 : Number(digits.slice(-2));
  if (!Number.isInteger(hours) || !Number.isInteger(minutes)) return null;
  if (hours > 23 || minutes > 59) return null;
  return { hours, minutes };
}

function formatTimeField(value) {
  const digits = String(value).replace(/\D/g, '').slice(0, 4);
  if (digits.length <= 2) return digits;
  return `${digits.slice(0, -2)}:${digits.slice(-2)}`;
}

function capitalize(text) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function nextSlot() {
  const start = new Date();
  start.setSeconds(0, 0);
  start.setMinutes(Math.ceil((start.getMinutes() + 1) / 30) * 30);
  return { start, end: new Date(start.getTime() + 3_600_000) };
}

export function createEventEditor({ send, toast, getCalendars, getSettings, onSaved, openExternal }) {
  let editing = null;

  function formError(message) {
    const el = $('#form-error');
    el.textContent = message;
    el.hidden = false;
  }

  function updatePreview() {
    const el = $('#form-preview');
    if (!el) return;
    const day = dateField.getValue();
    const start = parseTime($('#f-start').value);
    const end = parseTime($('#f-end').value);
    el.hidden = true;
    el.textContent = '';
    if (!day || !start || !end) return;

    const when = new Date(day.getFullYear(), day.getMonth(), day.getDate(), start.hours, start.minutes);
    const label = capitalize(
      new Intl.DateTimeFormat('ru-RU', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(when)
    );
    el.textContent = `${label} · ${pad2(start.hours)}:${pad2(start.minutes)}–${pad2(end.hours)}:${pad2(end.minutes)}`;
    el.hidden = false;
  }

  const dateField = createDateField({
    input: $('#f-date'),
    button: $('#f-date-open'),
    popup: $('#date-pop'),
    onChange: updatePreview,
  });

  function fillCalendarSelect(event) {
    const select = $('#f-calendar');
    select.replaceChildren();

    const calendars = [...getCalendars()];
    if (event && !calendars.some((cal) => cal.id === event.calendarId)) {
      calendars.push({ id: event.calendarId, summary: event.calendarName || 'Календарь' });
    }

    for (const cal of calendars) {
      const option = document.createElement('option');
      option.value = cal.id;
      option.textContent = cal.summary;
      select.append(option);
    }

    if (event) {
      select.value = event.calendarId;
      select.disabled = true;
      select.title = 'Календарь существующего события изменить нельзя';
      return;
    }

    select.disabled = false;
    select.title = '';
    const preferred = getSettings()?.defaultCalendarId;
    select.value = calendars.some((cal) => cal.id === preferred)
      ? preferred
      : calendars[0]?.id || 'primary';
  }

  function open(event = null, preset = null) {
    if (event && isAllDay(event)) {
      toast('События на весь день редактируются в Google Календаре');
      if (event.htmlLink) openExternal(event);
      return;
    }
    if (event && !canWrite(event.accessRole)) {
      toast('Календарь только для чтения — открываю событие в Google');
      if (event.htmlLink) openExternal(event);
      return;
    }

    editing = event ? { id: event.id, calendarId: event.calendarId } : null;
    $('#editor-title').textContent = event ? 'Событие' : 'Новое событие';
    $('#editor-delete').hidden = !event;
    $('#form-error').hidden = true;
    fillCalendarSelect(event);

    if (event) {
      $('#f-summary').value = event.summary;
      dateField.setValue(startDate(event), { silent: true });
      $('#f-start').value = toInputTime(startDate(event));
      $('#f-end').value = toInputTime(endDate(event));
    } else {
      const slot = preset || nextSlot();
      $('#f-summary').value = '';
      dateField.setValue(slot.start, { silent: true });
      $('#f-start').value = toInputTime(slot.start);
      $('#f-end').value = toInputTime(slot.end);
    }

    dateField.close();
    $('#f-location').value = event?.location || '';
    $('#f-description').value = event?.description || '';
    updatePreview();

    $('#editor').showModal();
    if (!event) $('#f-summary').focus();
  }

  function close() {
    $('#editor').close();
    editing = null;
  }

  async function submit(e) {
    e.preventDefault();
    const summary = $('#f-summary').value.trim();
    const day = dateField.getValue();
    const from = $('#f-start').value;
    const to = $('#f-end').value;

    if (!summary) return formError('Введите название события');
    if (!day) return formError('Выберите дату');
    if (!from || !to) return formError('Заполните время');

    const startTime = parseTime(from);
    const endTime = parseTime(to);
    if (!startTime || !endTime) return formError('Время — в формате ЧЧ:ММ, 24-часовой. Например, 14:30');

    const start = new Date(day.getFullYear(), day.getMonth(), day.getDate(), startTime.hours, startTime.minutes);
    const end = new Date(day.getFullYear(), day.getMonth(), day.getDate(), endTime.hours, endTime.minutes);
    if (end <= start) return formError('Конец должен быть позже начала');

    const settings = getSettings();
    const payload = {
      summary,
      description: $('#f-description').value.trim(),
      location: $('#f-location').value.trim(),
      startISO: start.toISOString(),
      endISO: end.toISOString(),
      reminders: settings?.reminders,
    };

    const saveButton = $('#editor-save');
    saveButton.disabled = true;
    try {
      if (editing) {
        await send('events:update', { id: editing.id, calendarId: editing.calendarId, ...payload });
      } else {
        const calendarId = $('#f-calendar').value || 'primary';
        await send('events:create', { calendarId, ...payload });
        if (settings && calendarId !== settings.defaultCalendarId) {
          settings.defaultCalendarId = calendarId;
          send('settings:save', { defaultCalendarId: calendarId }).catch(() => {});
        }
      }
      close();
      toast('Сохранено в Google Календаре');
      await onSaved();
    } catch (err) {
      formError(err.message);
    } finally {
      saveButton.disabled = false;
    }
  }

  async function remove() {
    if (!editing) return;
    const summary = $('#f-summary').value.trim() || 'это событие';
    if (!confirm(`Удалить «${summary}»?`)) return;
    try {
      await send('events:delete', { id: editing.id, calendarId: editing.calendarId });
      close();
      toast('Событие удалено');
      await onSaved();
    } catch (err) {
      formError(err.message);
    }
  }

  $('#event-form').addEventListener('submit', submit);
  $('#editor-cancel').addEventListener('click', close);
  $('#editor-close').addEventListener('click', close);
  $('#editor-delete').addEventListener('click', remove);
  $('#editor').addEventListener('click', (e) => {
    if (e.target === $('#editor')) close();
  });

  $('#f-date').addEventListener('input', updatePreview);
  for (const id of ['#f-start', '#f-end']) {
    const input = $(id);
    input.addEventListener('input', () => {
      input.value = formatTimeField(input.value);
      updatePreview();
    });
    input.addEventListener('blur', () => {
      if (!input.value.trim()) {
        updatePreview();
        return;
      }
      const parsed = parseTime(input.value);
      if (!parsed) {
        formError('Время должно быть от 00:00 до 23:59');
        updatePreview();
        return;
      }
      input.value = `${pad2(parsed.hours)}:${pad2(parsed.minutes)}`;
      $('#form-error').hidden = true;
      updatePreview();
    });
    input.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      // Enter отправляет форму — сначала приводим время к ЧЧ:ММ, чтобы не потерять ввод.
      const parsed = parseTime(input.value);
      input.value = parsed ? `${pad2(parsed.hours)}:${pad2(parsed.minutes)}` : '';
      updatePreview();
    });
  }

  return { open, close, isOpen: () => $('#editor').open };
}
