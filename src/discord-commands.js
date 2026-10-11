export const commandDefinitions = [
  {
    name: 'panel',
    description: 'Open your private Updater panel',
    type: 1,
    default_member_permissions: '8',
    dm_permission: false,
  },
];

// Only these retired commands are removed when upgrading an existing installation.
export const legacyCommandNames = [
  'overlay',
  'overlays',
  'previewoverlay',
  'testicon',
  'updategame',
  'gamestatus',
  'cancelgame',
  'icon',
];
