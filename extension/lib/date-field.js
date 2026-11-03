const pad = (n) => String(n).padStart(2, '0');

function startOfDay(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

function startOfWeek(date) {
  const d = startOfDay(date);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d;
}

function sameDay(a, b) {
  return Boolean(a && b) && a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function build(year, month, day) {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null;
  if (year < 1970 || year > 2999 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(year, month - 1, day);
  if (date.getMonth() !== month - 1 || date.getDate() !== day) return null;
  return date;
}

// Принимает дд.мм.гггг, дд.мм (текущий год), гггг-мм-дд и слитный ввод ддммгггг.
export function parseDateText(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;

  const iso = text.match(/^(\d{4})[-./](\d{1,2})[-./](\d{1,2})$/);
  if (iso) return build(Number(iso[1]), Number(iso[2]), Number(iso[3]));

  const parts = text.split(/[-./]/).filter(Boolean);
  if (parts.length === 3 && parts[2].length === 4) {
    return build(Number(parts[2]), Number(parts[1]), Number(parts[0]));
  }
  if (parts.length === 2) return build(new Date().getFullYear(), Number(parts[1]), Number(parts[0]));

  const digits = text.replace(/\D/g, '');
  if (digits.length === 4) return build(new Date().getFullYear(), Number(digits.slice(2)), Number(digits.slice(0, 2)));
  if (digits.length === 8) return build(Number(digits.slice(4, 8)), Number(digits.slice(2, 4)), Number(digits.slice(0, 2)));
  return null;
}

export function formatDate(date) {
  return `${pad(date.getDate())}.${pad(date.getMonth() + 1)}.${date.getFullYear()}`;
}

function monthTitle(date) {
  const text = new Intl.DateTimeFormat('ru-RU', { month: 'long', year: 'numeric' })
    .format(date)
    .replace(/\s*г\.$/, '');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function createDateField({ input, button, popup, onChange }) {
  let value = null;
  let view = startOfDay(new Date());

  function setValue(date, { silent = false } = {}) {
    value = date ? startOfDay(date) : null;
    input.value = value ? formatDate(value) : '';
    if (value) view = startOfDay(value);
    if (!silent) onChange?.(value);
  }

  function render() {
    const grid = popup.querySelector('#dp-grid');
    const first = new Date(view.getFullYear(), view.getMonth(), 1);
    const from = startOfWeek(first);
    const today = new Date();
    grid.replaceChildren();

    for (let index = 0; index < 42; index += 1) {
      const day = new Date(from);
      day.setDate(from.getDate() + index);

      const classes = ['dp-day'];
      if (day.getMonth() !== view.getMonth()) classes.push('other');
      if (sameDay(day, today)) classes.push('today');
      if (sameDay(day, value)) classes.push('selected');

      const cell = document.createElement('button');
      cell.type = 'button';
      cell.className = classes.join(' ');
      cell.textContent = String(day.getDate());
      cell.addEventListener('click', () => {
        setValue(day);
        close();
      });
      grid.append(cell);
    }

    popup.querySelector('#dp-title').textContent = monthTitle(view);
  }

  function position() {
    const rect = input.getBoundingClientRect();
    const width = popup.offsetWidth || 252;
    const height = popup.offsetHeight || 300;

    let left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
    let top = rect.bottom + 6;
    if (top + height > window.innerHeight - 8) top = Math.max(8, rect.top - height - 6);

    popup.style.left = `${Math.round(left)}px`;
    popup.style.top = `${Math.round(top)}px`;
  }

  function open() {
    if (value) view = startOfDay(value);
    render();
    popup.hidden = false;
    position();
  }

  function close() {
    popup.hidden = true;
  }

  button.addEventListener('click', () => {
    if (popup.hidden) open();
    else close();
  });

  popup.querySelector('#dp-prev').addEventListener('click', () => {
    view = new Date(view.getFullYear(), view.getMonth() - 1, 1);
    render();
  });
  popup.querySelector('#dp-next').addEventListener('click', () => {
    view = new Date(view.getFullYear(), view.getMonth() + 1, 1);
    render();
  });
  popup.querySelector('#dp-today').addEventListener('click', () => {
    setValue(new Date());
    close();
  });

  input.addEventListener('blur', () => {
    if (!input.value.trim()) {
      setValue(null);
      return;
    }
    const parsed = parseDateText(input.value);
    if (parsed) {
      setValue(parsed);
      return;
    }
    setValue(value, { silent: true });
    onChange?.(value);
  });

  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    input.blur();
  });

  document.addEventListener('pointerdown', (e) => {
    if (popup.hidden) return;
    if (e.target.closest('#date-pop') || e.target === button || e.target === input) return;
    close();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !popup.hidden) close();
  });

  return { setValue, getValue: () => value, open, close };
}
