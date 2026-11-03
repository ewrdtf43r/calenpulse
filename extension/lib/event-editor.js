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

function toInputDate(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function toInputTime(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
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
    if (event && (event.accessRole === 'reader' || event.accessRole === 'freeBusyReader')) {
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
      $('#f-date').value = toInputDate(startDate(event));
      $('#f-start').value = toInputTime(startDate(event));
      $('#f-end').value = toInputTime(endDate(event));
    } else {
      const slot = preset || nextSlot();
      $('#f-summary').value = '';
      $('#f-date').value = toInputDate(slot.start);
      $('#f-start').value = toInputTime(slot.start);
      $('#f-end').value = toInputTime(slot.end);
    }

    $('#f-location').value = event?.location || '';
    $('#f-description').value = event?.description || '';

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
    const date = $('#f-date').value;
    const from = $('#f-start').value;
    const to = $('#f-end').value;

    if (!summary) return formError('Введите название события');
    if (!date || !from || !to) return formError('Заполните дату и время');

    const start = new Date(`${date}T${from}:00`);
    const end = new Date(`${date}T${to}:00`);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return formError('Некорректная дата');
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

  return { open, close, isOpen: () => $('#editor').open };
}
