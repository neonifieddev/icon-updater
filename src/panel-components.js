import { STAGES } from './core.js';

export const row = (...components) => ({ type: 1, components });
export const componentId = (session, action, target = '') =>
  `p:${session.id}:${action}${target ? `:${target}` : ''}`;
const BUTTON_ICONS = {
  preview: '👀',
  update: '🚀',
  schedule: '📅',
  status: '📊',
  cancel: '⏹️',
  stop: '⏹️',
  overlays: '🎨',
  studios: '🏢',
  addgame: '➕',
  key: '🔑',
  disconnect: '🔌',
  'remove-key': '🔌',
  connect: '➕',
  home: '↩️',
  upload: '📤',
};
export const button = (
  session,
  action,
  label,
  target = '',
  style = 2,
  disabled = false,
) => ({
  type: 2,
  custom_id: componentId(session, action, target),
  label,
  style,
  disabled,
  ...(BUTTON_ICONS[action] ? { emoji: { name: BUTTON_ICONS[action] } } : {}),
});
export const label = (text, component, description) => ({
  type: 18,
  label: text,
  component,
  ...(description ? { description } : {}),
});
export const input = (customId, placeholder, maxLength = 80) => ({
  type: 4,
  custom_id: customId,
  style: 1,
  required: true,
  max_length: maxLength,
  placeholder,
});
export const select = (customId, options, placeholder) => ({
  type: 3,
  custom_id: customId,
  options,
  min_values: 1,
  max_values: 1,
  ...(placeholder ? { placeholder } : {}),
});
export const stageField = () =>
  label(
    '⏳ Countdown stage',
    select(
      'stage',
      STAGES.map(([value]) => ({
        label: value,
        value,
        emoji: { name: value === 'NOW' ? '🚀' : '⏳' },
      })),
    ),
  );
export const fileField = (overlay) =>
  label(
    overlay ? 'Overlay PNG' : 'Base icon',
    {
      type: 19,
      custom_id: 'image',
      min_values: 1,
      max_values: 1,
      required: true,
    },
    overlay
      ? 'Transparent square PNG, up to 5 MB.'
      : 'Square PNG or JPEG, up to 5 MB.',
  );
