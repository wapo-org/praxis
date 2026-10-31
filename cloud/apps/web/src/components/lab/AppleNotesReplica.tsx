import React from 'react';
import { GlassChip, GlassIconButton, GlassDropdown } from '@praxis/glass';
import { Share, MoreHorizontal, ScanLine, Pin, Lock, Search, Folder, Clock, FileText, Plus, Grid, LayoutGrid, Trash2 } from '../../lib/icons';
const RECENT_NOTES_ITEMS = [
  {
    id: 'note-1',
    text: 'am i missing something? the protestors are overwhelmingly peaceful and the police response has been disproportionate across every district',
  },
  {
    id: 'note-2',
    text: 'Using this repository, and plus find some for search optimization and refractive shader benchmarks in Chromium vs WebKit',
  },
  {
    id: 'note-3',
    text: 'figure of around 40% refers to ethnic kazakhs in the northern oblasts prior to the 1997 demographic transition',
  },
  {
    id: 'note-4',
    text: 'Hi, I got disconnected again. My name is Artem and I was reviewing the 35-frame Apple Notes Liquid Glass capture',
  },
  {
    id: 'note-5',
    text: 'Hi Fiero, / okay so to summarise the total code size and Snell law squircle bezel displacement profile across all four material tiers',
  },
];
export function AppleNotesReplica() {
  // 1. Apple Notes 35-Frame Reference Replica state (IMG_7744 – IMG_7778)
  const [notesMenuOpen, setNotesMenuOpen] = React.useState(false);
  const [notesSubPath, setNotesSubPath] = React.useState<string[]>([]);
  const [notePinned, setNotePinned] = React.useState(false);
  const [noteLocked, setNoteLocked] = React.useState(false);
  const [mathResultsMode, setMathResultsMode] = React.useState('suggest');
  const [attachmentView, setAttachmentView] = React.useState('gallery');
  const [lastNotesAction, setLastNotesAction] = React.useState<string>('Opened Apple Notes menu (IMG_7752)');

  return (
          <section
            data-testid="apple-notes-replica-section"
            style={{
              position: 'relative',
              borderRadius: '24px',
              border: '1px solid var(--paper-hairline)',
              backgroundColor: 'var(--paper-card)',
              padding: '22px',
              minHeight: '640px',
              display: 'flex',
              flexDirection: 'column',
              justifyContent: 'space-between',
              overflow: 'hidden',
            }}
          >
            {/* Simulated Apple Notes Top Toolbar + Underlying Note Prose */}
            <div>
              <div className="apple-notes-toolbar"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  marginBottom: '16px',
                  gap: '12px',
                  flexWrap: 'wrap',
                }}
              >
                <div>
                  <span
                    style={{
                      fontFamily: 'var(--font-mono)',
                      fontSize: '10px',
                      textTransform: 'uppercase',
                      letterSpacing: '0.08em',
                      color: 'var(--paper-muted-ink)',
                    }}
                  >
                    IMG_7744 – IMG_7778 Reference Replica
                  </span>
                  <h2 style={{ margin: '2px 0 0 0', fontSize: '16px', fontWeight: 600 }}>
                    Apple Notes Liquid Glass Pull-Down UIMenu
                  </h2>
                </div>

                <div className="apple-notes-actions" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <GlassChip
                    onClick={() => {
                      setNotesMenuOpen(true);
                      setNotesSubPath(
                        notesSubPath.includes('recent-notes') ? [] : ['recent-notes'],
                      );
                    }}
                  >
                    {notesSubPath.includes('recent-notes')
                      ? 'Collapse Recent Notes ⌄'
                      : 'Morph Recent Notes ›'}
                  </GlassChip>

                  <GlassIconButton label="Share Note">
                    <Share size={15} />
                  </GlassIconButton>

                  <GlassDropdown
                    portal
                    open={notesMenuOpen}
                    onOpenChange={setNotesMenuOpen}
                    subPath={notesSubPath}
                    onSubPathChange={setNotesSubPath}
                    align="end"
                    side="bottom"
                    submenuMode="morph"
                  >
                    <GlassDropdown.Trigger
                      data-testid="apple-notes-menu-trigger"
                      aria-label="More Note Actions"
                      hideChevron
                    >
                      <MoreHorizontal size={16} />
                    </GlassDropdown.Trigger>

                    <GlassDropdown.Content minWidth={240} maxHeight={460}>
                      {/* Top 3-column Quick-Action Tile Row (IMG_7749: Scan | Pin Note | Lock) */}
                      <GlassDropdown.ActionGrid columns={3}>
                        <GlassDropdown.TileItem
                          icon={<ScanLine size={16} />}
                          onSelect={() => setLastNotesAction('Scanned document into note')}
                        >
                          Scan
                        </GlassDropdown.TileItem>
                        <GlassDropdown.TileItem
                          icon={<Pin size={16} />}
                          active={notePinned}
                          keepOpen
                          onSelect={() => {
                            setNotePinned((p) => !p);
                            setLastNotesAction(notePinned ? 'Unpinned note' : 'Pinned note');
                          }}
                        >
                          Pin Note
                        </GlassDropdown.TileItem>
                        <GlassDropdown.TileItem
                          icon={<Lock size={16} />}
                          active={noteLocked}
                          keepOpen
                          onSelect={() => {
                            setNoteLocked((l) => !l);
                            setLastNotesAction(noteLocked ? 'Unlocked note' : 'Locked note');
                          }}
                        >
                          Lock
                        </GlassDropdown.TileItem>
                      </GlassDropdown.ActionGrid>

                      {/* Primary Action List */}
                      <GlassDropdown.Item
                        icon={<Search size={15} />}
                        onSelect={() => setLastNotesAction('Find in Note')}
                      >
                        Find in Note
                      </GlassDropdown.Item>

                      <GlassDropdown.Item
                        icon={<Folder size={15} />}
                        onSelect={() => setLastNotesAction('Move Note')}
                      >
                        Move Note
                      </GlassDropdown.Item>

                      {/* Expandable In-Place Morph Submenu (IMG_7769–IMG_7774: Recent Notes › -> Recent Notes ⌄) */}
                      <GlassDropdown.Sub
                        id="recent-notes"
                        label="Recent Notes"
                        icon={<Clock size={15} />}
                      >
                        <GlassDropdown.SubTrigger
                          data-testid="recent-notes-subtrigger"
                          icon={<Clock size={15} />}
                        >
                          Recent Notes
                        </GlassDropdown.SubTrigger>
                        <GlassDropdown.SubContent>
                          {RECENT_NOTES_ITEMS.map((note) => (
                              <GlassDropdown.Item
                                key={note.id}
                                lines={3}
                                icon={<FileText size={15} />}
                                onSelect={() =>
                                  setLastNotesAction(`Opened recent note: ${note.text.slice(0, 28)}…`)
                                }
                              >
                                {note.text}
                              </GlassDropdown.Item>
                          ))}
                        </GlassDropdown.SubContent>
                      </GlassDropdown.Sub>

                      {/* Math Results Submenu */}
                      <GlassDropdown.Sub
                        id="math-results"
                        label="Math Results"
                        icon={<Plus size={15} />}
                      >
                        <GlassDropdown.SubTrigger
                          icon={<Plus size={15} />}
                          subtitle={mathResultsMode === 'insert' ? 'Insert Results' : 'Suggest Results'}
                        >
                          Math Results
                        </GlassDropdown.SubTrigger>
                        <GlassDropdown.SubContent>
                          <GlassDropdown.RadioGroup
                            value={mathResultsMode}
                            onValueChange={(val) => {
                              setMathResultsMode(val);
                              setLastNotesAction(`Math Results: ${val}`);
                            }}
                          >
                            <GlassDropdown.RadioItem value="insert">
                              Insert Results
                            </GlassDropdown.RadioItem>
                            <GlassDropdown.RadioItem value="suggest">
                              Suggest Results
                            </GlassDropdown.RadioItem>
                          </GlassDropdown.RadioGroup>
                        </GlassDropdown.SubContent>
                      </GlassDropdown.Sub>

                      <GlassDropdown.Item
                        icon={<Grid size={15} />}
                        onSelect={() => setLastNotesAction('Lines & Grids')}
                      >
                        Lines &amp; Grids
                      </GlassDropdown.Item>

                      <GlassDropdown.Sub
                        id="attachment-view"
                        label="Attachment View"
                        icon={<LayoutGrid size={15} />}
                      >
                        <GlassDropdown.SubTrigger icon={<LayoutGrid size={15} />}>
                          Attachment View
                        </GlassDropdown.SubTrigger>
                        <GlassDropdown.SubContent>
                          <GlassDropdown.RadioGroup
                            value={attachmentView}
                            onValueChange={(val) => {
                              setAttachmentView(val);
                              setLastNotesAction(`Attachment View: ${val}`);
                            }}
                          >
                            <GlassDropdown.RadioItem value="gallery">
                              Gallery View
                            </GlassDropdown.RadioItem>
                            <GlassDropdown.RadioItem value="list">
                              List View
                            </GlassDropdown.RadioItem>
                          </GlassDropdown.RadioGroup>
                        </GlassDropdown.SubContent>
                      </GlassDropdown.Sub>


                      {/* Destructive Footer Section */}
                      <GlassDropdown.Item
                        tone="destructive"
                        icon={<Trash2 size={15} />}
                        onSelect={() => setLastNotesAction('Deleted Note')}
                      >
                        Delete
                      </GlassDropdown.Item>
                    </GlassDropdown.Content>
                  </GlassDropdown>
                </div>
              </div>

              {/* Underlying Note Editorial Text from IMG_7744 ("protests through history is primarily brutal and...") */}
              <div
                style={{
                  padding: '18px',
                  borderRadius: '16px',
                  backgroundColor: 'var(--paper-canvas)',
                  border: '1px solid var(--paper-hairline)',
                  fontFamily: 'var(--font-serif)',
                  fontSize: '17px',
                  lineHeight: '28px',
                  color: 'var(--paper-ink)',
                }}
              >
                <div
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: '11px',
                    color: 'var(--paper-muted-ink)',
                    marginBottom: '8px',
                  }}
                >
                  October 29 · Field Archive Note #7744
                </div>
                <p style={{ margin: '0 0 14px 0' }}>
                  The documentary record of civil protests through history is primarily brutal and
                  fraught with unintended consequences when no independent group for law and civic
                  mediation exists on the ground. Even where initial assemblies form around quiet
                  petitions, the absence of transparent dialogue rapidly amplifies friction.
                </p>
                <p style={{ margin: '0 0 14px 0' }}>
                  Notice how the open Liquid Glass menu above refracts these underlying serif words
                  along its 20px Snell squircle bezel while keeping the interior menu labels crisp
                  and effortless to scan. Dragging across rows scrubs the fluid highlight pill and
                  stretches the glass card with asymptotic rubber-band physics.
                </p>
                <p style={{ margin: 0, color: 'var(--paper-secondary-ink)', fontSize: '15px' }}>
                  Click <strong>Recent Notes</strong> inside the menu (or the quick morph chip in
                  the header) to trigger the in-place submenu elevation from <code>IMG_7769</code>–
                  <code>IMG_7774</code>, revealing 5 three-line note previews.
                </p>
              </div>
            </div>

            <div
              data-testid="apple-notes-status"
              style={{
                marginTop: '16px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                fontSize: '12px',
                fontFamily: 'var(--font-mono)',
                color: 'var(--paper-secondary-ink)',
                paddingTop: '12px',
                borderTop: '1px solid var(--paper-hairline)',
              }}
            >
              <span>Last action: {lastNotesAction}</span>
              <span>
                {notePinned ? '📌 Pinned ' : ''}
                {noteLocked ? '🔒 Locked' : 'Unlocked'}
              </span>
            </div>
          </section>
  );
}
