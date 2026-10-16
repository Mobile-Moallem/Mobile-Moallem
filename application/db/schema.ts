import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const hymnLibraryPresentation = sqliteTable("hymn_library_presentation", {
  hymnId: text("hymn_id").primaryKey(),
  title: text("title"),
  folderOrder: integer("folder_order"),
  updatedAt: integer("updated_at").notNull(),
});

export const hymnProjects = sqliteTable("hymn_projects", {
  hymnId: text("hymn_id").primaryKey(),
  title: text("title").notNull(),
  season: text("season").notNull(),
  service: text("service").notNull(),
  ownerEmail: text("owner_email").notNull(),
  status: text("status").notNull().default("draft"),
  timingsJson: text("timings_json").notNull().default("[]"),
  copticTimingsJson: text("coptic_timings_json").notNull().default("[]"),
  hazzatTimingsJson: text("hazzat_timings_json").notNull().default("[]"),
  hazzatLineTimingsJson: text("hazzat_line_timings_json").notNull().default("[]"),
  recordingUrl: text("recording_url"),
  recordingKey: text("recording_key"),
  englishRecordingUrl: text("english_recording_url"),
  englishRecordingKey: text("english_recording_key"),
  copticRecordingUrl: text("coptic_recording_url"),
  copticRecordingKey: text("coptic_recording_key"),
  notationHtml: text("notation_html"),
  textContent: text("text_content"),
  copticText: text("coptic_text"),
  notationKey: text("notation_key"),
  updatedAt: integer("updated_at").notNull(),
  completedAt: integer("completed_at"),
}, (table) => [
  index("idx_hymn_projects_owner_updated").on(table.ownerEmail, table.updatedAt),
  index("idx_hymn_projects_status").on(table.status),
]);

export const alignmentSuggestions = sqliteTable("alignment_suggestions", {
  id: text("id").primaryKey(),
  hymnId: text("hymn_id").notNull(),
  section: text("section").notNull(),
  sourceUrl: text("source_url").notNull(),
  status: text("status").notNull().default("queued"),
  payloadJson: text("payload_json").notNull().default("{}"),
  version: integer("version").notNull().default(1),
  updatedAt: integer("updated_at").notNull(),
}, table => [uniqueIndex("idx_alignment_hymn_section").on(table.hymnId, table.section)]);

export const referenceAlignmentDrafts = sqliteTable("reference_alignment_drafts", {
  id: text("id").primaryKey(),
  hymnId: text("hymn_id").notNull(),
  section: text("section").notNull(),
  payloadJson: text("payload_json").notNull().default("{}"),
  revision: integer("revision").notNull().default(1),
  status: text("status").notNull().default("review"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
}, table => [index("idx_reference_alignment_hymn_updated").on(table.hymnId, table.updatedAt)]);
