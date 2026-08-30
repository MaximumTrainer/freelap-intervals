export type SyncMode = 'attach' | 'create-new'

export type SyncChoice = { readonly mode: 'create-new' } | { readonly mode: 'attach'; readonly activityId: string }
