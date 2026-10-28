// ============================================================================
// OW — Calendar / task notebook
// ----------------------------------------------------------------------------
// A real month planner: every day can hold tasks with time, priority and notes.
// Tasks persist locally (offline-first) and the month/week labels follow the
// instant AR/EN switch. No fixed demo month, no fake navigation controls.
// ============================================================================
import { controlPanel } from './comp-control-panel.js';
import { tx, isAr } from './core-i18n.js';
import { esc, input, select, textarea } from './core-ui.js';
import { modal, confirmDialog } from './core-modal.js';
import { toast } from './core-toast.js';
import { OW } from './core-registry.js';

const STORE_KEY = 'ow_calendar_tasks_v1';
const MONTHS = {
  ar: ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'],
  en: ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
};
const WEEKDAYS = [
  { ar: 'الإثنين', shortAr: 'إثن', en: 'Monday', shortEn: 'Mon' },
  { ar: 'الثلاثاء', shortAr: 'ثلا', en: 'Tuesday', shortEn: 'Tue' },
  { ar: 'الأربعاء', shortAr: 'أرب', en: 'Wednesday', shortEn: 'Wed' },
  { ar: 'الخميس', shortAr: 'خمي', en: 'Thursday', shortEn: 'Thu' },
  { ar: 'الجمعة', shortAr: 'جمع', en: 'Friday', shortEn: 'Fri' },
  { ar: 'السبت', shortAr: 'سبت', en: 'Saturday', shortEn: 'Sat' },
  { ar: 'الأحد', shortAr: 'أحد', en: 'Sunday', shortEn: 'Sun' }
];
const PRIORITIES = {
  low:    { ar: 'منخفضة', en: 'Low',    color: '#5B899E', icon: 'fa-arrow-down' },
  normal: { ar: 'عادية',  en: 'Normal', color: '#714B67', icon: 'fa-minus' },
  high:   { ar: 'عالية',  en: 'High',   color: '#a61b1b', icon: 'fa-arrow-up' }
};

const todayKey = () => dateKey(new Date());
const monthStart = d => new Date(d.getFullYear(), d.getMonth(), 1);

let viewDate = monthStart(new Date());
let selectedDate = todayKey();
let filter = 'all'; // all | open | done

function dateKey(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function parseDate(key) {
  const [y, m, d] = String(key).split('-').map(Number);
  return new Date(y || 1970, (m || 1) - 1, d || 1);
}

function readTasks() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE_KEY) || '[]');
    if (!Array.isArray(raw)) return [];
    return raw
      .filter(t => t && t.title && /^\d{4}-\d{2}-\d{2}$/.test(String(t.date || '')))
      .map(t => ({
        id: String(t.id || uid()),
        title: String(t.title).trim(),
        date: String(t.date),
        time: String(t.time || ''),
        priority: PRIORITIES[t.priority] ? t.priority : 'normal',
        notes: String(t.notes || ''),
        done: !!t.done,
        createdAt: t.createdAt || new Date().toISOString()
      }));
  } catch (_) {
    return [];
  }
}

function writeTasks(tasks) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(tasks));
    return true;
  } catch (err) {
    toast(tx('تعذر حفظ المهمة على هذا الجهاز', 'Could not save the task on this device'), 'error');
    console.warn('[calendar] save failed', err);
    return false;
  }
}

function uid() {
  return window.crypto?.randomUUID?.() || `cal-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function monthLabel(date = viewDate) {
  return `${MONTHS[isAr() ? 'ar' : 'en'][date.getMonth()]} ${date.getFullYear()}`;
}

function weekdayLabel(key, short = false) {
  const idx = (parseDate(key).getDay() + 6) % 7;
  const w = WEEKDAYS[idx];
  if (isAr()) return short ? w.shortAr : w.ar;
  return short ? w.shortEn : w.en;
}

function longDate(key) {
  const d = parseDate(key);
  const ar = isAr();
  return `${weekdayLabel(key)}, ${d.getDate()} ${MONTHS[ar ? 'ar' : 'en'][d.getMonth()]} ${d.getFullYear()}`;
}

function priorityLabel(value) {
  const p = PRIORITIES[value] || PRIORITIES.normal;
  return isAr() ? p.ar : p.en;
}

function matchesFilter(task) {
  if (filter === 'open') return !task.done;
  if (filter === 'done') return task.done;
  return true;
}

function sortTasks(list) {
  return [...list].sort((a, b) => {
    if (a.done !== b.done) return a.done ? 1 : -1;
    return `${a.time || '99:99'} ${a.title}`.localeCompare(`${b.time || '99:99'} ${b.title}`);
  });
}

function tasksForDate(tasks, key) {
  return sortTasks(tasks.filter(t => t.date === key && matchesFilter(t)));
}

function taskChip(task) {
  const p = PRIORITIES[task.priority] || PRIORITIES.normal;
  return `<span class="o_cal_chip ${task.done ? 'done' : ''}" style="--chip:${p.color}" title="${esc(task.title)}">
    <i class="fa-solid ${task.done ? 'fa-check' : p.icon}"></i>
    <span>${esc(task.title)}</span>
    ${task.time ? `<small>${esc(task.time)}</small>` : ''}
  </span>`;
}

function statBox(icon, value, label, tone = '') {
  return `<div class="o_cal_stat ${tone}">
    <span class="o_cal_stat_icon"><i class="${icon}"></i></span>
    <div><b>${value}</b><small>${label}</small></div>
  </div>`;
}

function renderGrid(tasks) {
  const year = viewDate.getFullYear();
  const month = viewDate.getMonth();
  const first = new Date(year, month, 1);
  const offset = (first.getDay() + 6) % 7; // Monday = 0
  const start = new Date(year, month, 1 - offset);
  const today = todayKey();
  const cells = [];
  for (let i = 0; i < 42; i++) {
    const date = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    const key = dateKey(date);
    const outside = date.getMonth() !== month;
    const allTasks = tasks.filter(t => t.date === key);
    const visible = tasksForDate(tasks, key);
    const open = allTasks.filter(t => !t.done).length;
    const classes = [
      'o_cal_day',
      outside ? 'outside' : '',
      key === today ? 'today' : '',
      key === selectedDate ? 'selected' : '',
      allTasks.length ? 'has-tasks' : ''
    ].filter(Boolean).join(' ');
    cells.push(`
      <div class="${classes}" role="button" tabindex="0" data-cal-day="${key}"
        aria-label="${esc(`${longDate(key)} — ${allTasks.length} ${tx('مهمة', 'task(s)')}`)}">
        <div class="o_cal_daytop">
          <span class="o_cal_daynum">${date.getDate()}</span>
          ${allTasks.length && !outside ? `<span class="o_cal_daycount">${allTasks.length}</span>` : ''}
        </div>
        <div class="o_cal_dots" aria-hidden="true">
          ${allTasks.slice(0, 4).map(t => `<i class="${t.done ? 'done' : ''}" style="--dot:${(PRIORITIES[t.priority] || PRIORITIES.normal).color}"></i>`).join('')}
          ${allTasks.length > 4 ? `<b>+${allTasks.length - 4}</b>` : ''}
        </div>
        <div class="o_cal_chips">
          ${visible.slice(0, 2).map(taskChip).join('')}
          ${visible.length > 2 ? `<span class="o_cal_more">+${visible.length - 2}</span>` : ''}
        </div>
        ${open && !outside ? `<span class="o_cal_open_dot" title="${tx('مهام مفتوحة', 'Open tasks')}"></span>` : ''}
      </div>`);
  }
  return `
    <div class="o_cal_grid_head">
      ${WEEKDAYS.map(w => `<div>${tx(w.shortAr, w.shortEn)}</div>`).join('')}
    </div>
    <div class="o_cal_grid">${cells.join('')}</div>`;
}

function renderAgenda(tasks) {
  const dayTasks = tasksForDate(tasks, selectedDate);
  const allDayTasks = tasks.filter(t => t.date === selectedDate);
  return `
    <aside class="o_cal_side">
      <div class="o_cal_side_head">
        <div>
          <small>${esc(weekdayLabel(selectedDate))}</small>
          <h3>${esc(longDate(selectedDate))}</h3>
        </div>
        <button class="o_btn o_btn_primary o_btn_sm" data-cal-new="${selectedDate}" title="${tx('إضافة مهمة', 'Add task')}">
          <i class="fa-solid fa-plus"></i><span>${tx('مهمة', 'Task')}</span>
        </button>
      </div>
      <div class="o_cal_side_meta">
        <span><i class="fa-regular fa-circle-check"></i> ${allDayTasks.filter(t => t.done).length} ${tx('مكتملة', 'done')}</span>
        <span><i class="fa-regular fa-circle"></i> ${allDayTasks.filter(t => !t.done).length} ${tx('مفتوحة', 'open')}</span>
      </div>
      <div class="o_cal_agenda">
        ${dayTasks.length ? dayTasks.map(task => `
          <div class="o_cal_task ${task.done ? 'done' : ''}" data-task="${task.id}">
            <button class="o_cal_check" data-cal-toggle="${task.id}" title="${task.done ? tx('إعادة فتح المهمة', 'Reopen task') : tx('إكمال المهمة', 'Complete task')}">
              <i class="fa-${task.done ? 'solid fa-check' : 'regular fa-circle'}"></i>
            </button>
            <div class="o_cal_task_body">
              <b>${esc(task.title)}</b>
              <div class="o_cal_task_meta">
                <span class="o_cal_priority" style="--p:${(PRIORITIES[task.priority] || PRIORITIES.normal).color}">
                  <i class="fa-solid ${(PRIORITIES[task.priority] || PRIORITIES.normal).icon}"></i> ${priorityLabel(task.priority)}
                </span>
                ${task.time ? `<span><i class="fa-regular fa-clock"></i> ${esc(task.time)}</span>` : ''}
              </div>
              ${task.notes ? `<p>${esc(task.notes)}</p>` : ''}
            </div>
            <div class="o_cal_task_actions">
              <button data-cal-edit="${task.id}" title="${tx('تعديل', 'Edit')}"><i class="fa-solid fa-pen"></i></button>
              <button data-cal-del="${task.id}" class="danger" title="${tx('حذف', 'Delete')}"><i class="fa-solid fa-trash-can"></i></button>
            </div>
          </div>`).join('') : `
          <div class="o_cal_empty">
            <i class="fa-regular fa-calendar-plus"></i>
            <b>${tx('لا توجد مهام في هذا اليوم', 'No tasks for this day')}</b>
            <span>${tx('أضف مهمة لتبدأ تنظيم يومك.', 'Add a task to start planning your day.')}</span>
            <button class="o_btn o_btn_primary o_btn_sm" data-cal-new="${selectedDate}">
              <i class="fa-solid fa-plus"></i> ${tx('إضافة مهمة', 'Add task')}
            </button>
          </div>`}
      </div>
    </aside>`;
}

function renderPage() {
  const tasks = readTasks();
  const monthPrefix = `${viewDate.getFullYear()}-${String(viewDate.getMonth() + 1).padStart(2, '0')}`;
  const monthTasks = tasks.filter(t => t.date.startsWith(monthPrefix));
  const open = monthTasks.filter(t => !t.done).length;
  const done = monthTasks.length - open;
  const overdue = tasks.filter(t => !t.done && t.date < todayKey()).length;
  const prevIcon = isAr() ? 'right' : 'left';
  const nextIcon = isAr() ? 'left' : 'right';
  const progress = monthTasks.length ? Math.round((done / monthTasks.length) * 100) : 0;

  return `
    ${controlPanel({
      breadcrumb: [
        { label: tx('التطبيقات', 'Apps'), page: 'apps' },
        { label: monthLabel() }
      ],
      search: false,
      buttons: `
        <button class="o_btn o_btn_primary" data-cal-new="${selectedDate}">
          <i class="fa-solid fa-plus"></i> ${tx('مهمة جديدة', 'New task')}
        </button>
        <button class="o_btn o_btn_secondary" data-cal-today>
          <i class="fa-regular fa-calendar-check"></i> ${tx('اليوم', 'Today')}
        </button>`
    })}
    <div class="o_page_body o_calendar_page">
      <div class="o_cal_stats">
        ${statBox('fa-solid fa-list-check', monthTasks.length, tx('مهام الشهر', 'This month'))}
        ${statBox('fa-regular fa-circle', open, tx('مفتوحة', 'Open'), 'open')}
        ${statBox('fa-solid fa-circle-check', done, tx('مكتملة', 'Completed'), 'done')}
        ${statBox('fa-solid fa-triangle-exclamation', overdue, tx('متأخرة', 'Overdue'), overdue ? 'late' : '')}
        <div class="o_cal_progress">
          <div><span>${tx('إنجاز الشهر', 'Month progress')}</span><b>${progress}%</b></div>
          <div class="o_cal_progress_bar"><i style="width:${progress}%"></i></div>
        </div>
      </div>

      <div class="o_cal_toolbar">
        <div class="o_cal_monthnav">
          <button class="o_cal_navbtn" data-cal-prev title="${tx('الشهر السابق', 'Previous month')}">
            <i class="fa-solid fa-chevron-${prevIcon}"></i>
          </button>
          <strong>${esc(monthLabel())}</strong>
          <button class="o_cal_navbtn" data-cal-next title="${tx('الشهر التالي', 'Next month')}">
            <i class="fa-solid fa-chevron-${nextIcon}"></i>
          </button>
        </div>
        <div class="o_cal_filters" role="group" aria-label="${tx('تصفية المهام', 'Filter tasks')}">
          <button data-cal-filter="all" class="${filter === 'all' ? 'active' : ''}">${tx('الكل', 'All')}</button>
          <button data-cal-filter="open" class="${filter === 'open' ? 'active' : ''}">${tx('مفتوحة', 'Open')}</button>
          <button data-cal-filter="done" class="${filter === 'done' ? 'active' : ''}">${tx('مكتملة', 'Done')}</button>
        </div>
      </div>

      <div class="o_calendar_layout">
        <section class="o_cal_main">
          ${renderGrid(tasks)}
        </section>
        ${renderAgenda(tasks)}
      </div>
    </div>`;
}

function openTaskModal(taskId = null, presetDate = selectedDate) {
  const tasks = readTasks();
  const existing = taskId ? tasks.find(t => t.id === taskId) : null;
  const value = existing || { title: '', date: presetDate, time: '', priority: 'normal', notes: '', done: false };
  const body = `<form id="calTaskForm" class="o_form_grid o_cal_form">
    ${input({ name: 'title', label: tx('عنوان المهمة', 'Task title'), value: value.title, required: true, full: true, placeholder: tx('مثال: مراجعة الجرد الشهري', 'e.g. Review monthly stocktake') })}
    ${input({ name: 'date', label: tx('التاريخ', 'Date'), value: value.date, type: 'date', required: true })}
    ${input({ name: 'time', label: tx('الوقت', 'Time'), value: value.time, type: 'time' })}
    ${select({
      name: 'priority',
      label: tx('الأولوية', 'Priority'),
      value: value.priority,
      options: Object.entries(PRIORITIES).map(([key, p]) => ({ value: key, label: isAr() ? p.ar : p.en }))
    })}
    ${textarea({ name: 'notes', label: tx('ملاحظات', 'Notes'), value: value.notes, rows: 3, placeholder: tx('تفاصيل إضافية…', 'Additional details…') })}
    <div class="o_field full o_cal_done_field">
      <label class="o_checkbox"><input type="checkbox" name="done" ${value.done ? 'checked' : ''}> ${tx('المهمة مكتملة', 'Task is completed')}</label>
    </div>
    <div class="o_field full o_prompt_error" id="calTaskError" style="display:none;color:#a61b1b"></div>
  </form>`;
  modal({
    title: `<i class="fa-regular fa-calendar-plus"></i> ${existing ? tx('تعديل المهمة', 'Edit task') : tx('مهمة جديدة', 'New task')}`,
    size: 'md',
    body,
    footer: `<button class="o_btn o_btn_secondary" data-cancel>${tx('إلغاء', 'Cancel')}</button>
             <button class="o_btn o_btn_primary" data-save><i class="fa-regular fa-floppy-disk"></i> ${tx('حفظ', 'Save')}</button>`,
    onMount: (el, close) => {
      const form = el.querySelector('#calTaskForm');
      const error = el.querySelector('#calTaskError');
      const titleInput = form.querySelector('[name="title"]');
      titleInput?.focus();
      el.querySelector('[data-cancel]').onclick = close;
      const save = () => {
        const data = Object.fromEntries(new FormData(form).entries());
        const title = String(data.title || '').trim();
        const date = String(data.date || '');
        if (!title) {
          error.textContent = tx('عنوان المهمة مطلوب', 'Task title is required');
          error.style.display = 'block';
          titleInput?.focus();
          return;
        }
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
          error.textContent = tx('التاريخ غير صالح', 'Invalid date');
          error.style.display = 'block';
          return;
        }
        const next = readTasks();
        const payload = {
          title,
          date,
          time: String(data.time || ''),
          priority: PRIORITIES[data.priority] ? data.priority : 'normal',
          notes: String(data.notes || '').trim(),
          done: !!data.done
        };
        if (existing) {
          const idx = next.findIndex(t => t.id === existing.id);
          if (idx >= 0) next[idx] = { ...next[idx], ...payload };
        } else {
          next.push({ id: uid(), ...payload, createdAt: new Date().toISOString() });
        }
        if (!writeTasks(next)) return;
        close();
        selectedDate = date;
        const chosen = parseDate(date);
        viewDate = monthStart(chosen);
        refresh();
        toast(existing ? tx('تم تحديث المهمة', 'Task updated') : tx('تمت إضافة المهمة', 'Task added'), 'success');
      };
      el.querySelector('[data-save]').onclick = save;
      form.addEventListener('submit', e => { e.preventDefault(); save(); });
    }
  });
}

function deleteTask(id) {
  const task = readTasks().find(t => t.id === id);
  if (!task) return;
  confirmDialog({
    title: tx('حذف المهمة', 'Delete task'),
    message: tx(`هل تريد حذف «${esc(task.title)}»؟ لا يمكن التراجع عن هذا الإجراء.`,
      `Delete “${esc(task.title)}”? This action cannot be undone.`),
    confirmText: tx('حذف', 'Delete'),
    cancelText: tx('إلغاء', 'Cancel'),
    dangerous: true
  }).then(ok => {
    if (!ok) return;
    const next = readTasks().filter(t => t.id !== id);
    if (!writeTasks(next)) return;
    refresh();
    toast(tx('تم حذف المهمة', 'Task deleted'), 'info');
  });
}

function toggleTask(id) {
  const next = readTasks();
  const task = next.find(t => t.id === id);
  if (!task) return;
  task.done = !task.done;
  if (!writeTasks(next)) return;
  refresh();
}

function refresh() {
  const main = document.getElementById('mainContent');
  if (!main) return;
  main.innerHTML = renderPage();
  OW.updateMobileNav?.('calendar');
  bind(main);
}

function bind(main) {
  main.onclick = e => {
    const target = e.target.closest('[data-cal-day],[data-cal-prev],[data-cal-next],[data-cal-today],[data-cal-filter],[data-cal-new],[data-cal-edit],[data-cal-del],[data-cal-toggle]');
    if (!target) return;

    if (target.dataset.calDay) {
      selectedDate = target.dataset.calDay;
      refresh();
      return;
    }
    if (target.hasAttribute('data-cal-prev')) {
      viewDate = new Date(viewDate.getFullYear(), viewDate.getMonth() - 1, 1);
      selectedDate = dateKey(viewDate);
      refresh();
      return;
    }
    if (target.hasAttribute('data-cal-next')) {
      viewDate = new Date(viewDate.getFullYear(), viewDate.getMonth() + 1, 1);
      selectedDate = dateKey(viewDate);
      refresh();
      return;
    }
    if (target.hasAttribute('data-cal-today')) {
      const now = new Date();
      viewDate = monthStart(now);
      selectedDate = dateKey(now);
      refresh();
      return;
    }
    if (target.dataset.calFilter) {
      filter = target.dataset.calFilter;
      refresh();
      return;
    }
    if (target.dataset.calNew) {
      openTaskModal(null, target.dataset.calNew);
      return;
    }
    if (target.dataset.calEdit) {
      openTaskModal(target.dataset.calEdit);
      return;
    }
    if (target.dataset.calDel) {
      deleteTask(target.dataset.calDel);
      return;
    }
    if (target.dataset.calToggle) {
      toggleTask(target.dataset.calToggle);
    }
  };

  main.onkeydown = e => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const day = e.target.closest('[data-cal-day]');
    if (!day) return;
    e.preventDefault();
    selectedDate = day.dataset.calDay;
    refresh();
  };
}

export default {
  name: 'calendar',
  get brand() {
    return { name: tx('التقويم', 'Calendar'), icon: 'fa-regular fa-calendar' };
  },
  get menu() {
    return [{ label: tx('التقويم', 'Calendar'), page: 'calendar' }];
  },
  render: renderPage,
  mount(_params, main) {
    bind(main);
  }
};
