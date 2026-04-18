#include <dlfcn.h>
#include <fcntl.h>
#include <dirent.h>
#include <limits.h>
#include <mach/mach.h>
#include <mach-o/dyld.h>
#include <mach-o/getsect.h>
#include <mach-o/loader.h>
#include <mach-o/nlist.h>
#include <stdbool.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#include <CommonCrypto/CommonKeyDerivation.h>

// We only need sqlite3 as an opaque type.
typedef struct sqlite3 sqlite3;
typedef struct sqlite3_stmt sqlite3_stmt;

#define SQLITE_OK 0
#define SQLITE_ROW 100
#define SQLITE_DONE 101

// ---- Minimal fishhook (symbol rebinding) ----
// Based on the public domain/BSD-licensed fishhook implementation.
// We inline a minimal copy here to avoid extra build steps.

struct rebinding {
  const char *name;
  void *replacement;
  void **replaced;
};

struct rebindings_entry {
  struct rebinding *rebindings;
  size_t rebindings_nel;
  struct rebindings_entry *next;
};

static struct rebindings_entry *rebindings_head;

static int prepend_rebindings(struct rebindings_entry **head, struct rebinding rebindings[],
                              size_t nel) {
  struct rebindings_entry *new_entry =
      (struct rebindings_entry *)malloc(sizeof(struct rebindings_entry));
  if (!new_entry) {
    return -1;
  }
  new_entry->rebindings = (struct rebinding *)malloc(sizeof(struct rebinding) * nel);
  if (!new_entry->rebindings) {
    free(new_entry);
    return -1;
  }
  memcpy(new_entry->rebindings, rebindings, sizeof(struct rebinding) * nel);
  new_entry->rebindings_nel = nel;
  new_entry->next = *head;
  *head = new_entry;
  return 0;
}

#if __LP64__
typedef struct mach_header_64 mach_header_t;
typedef struct segment_command_64 segment_command_t;
typedef struct section_64 section_t;
typedef struct nlist_64 nlist_t;
#define LC_SEGMENT_ARCH_DEPENDENT LC_SEGMENT_64
#else
typedef struct mach_header mach_header_t;
typedef struct segment_command segment_command_t;
typedef struct section section_t;
typedef struct nlist nlist_t;
#define LC_SEGMENT_ARCH_DEPENDENT LC_SEGMENT
#endif

static void perform_rebinding_with_section(struct rebindings_entry *rebindings, section_t *section,
                                           intptr_t slide, nlist_t *symtab, char *strtab,
                                           uint32_t *indirect_symtab) {
  if ((section->flags & SECTION_TYPE) != S_LAZY_SYMBOL_POINTERS &&
      (section->flags & SECTION_TYPE) != S_NON_LAZY_SYMBOL_POINTERS) {
    return;
  }

  uint32_t *indirect_symbol_indices = indirect_symtab + section->reserved1;
  void **indirect_symbol_bindings = (void **)((uintptr_t)slide + section->addr);
  size_t count = (size_t)(section->size / sizeof(void *));

  for (size_t i = 0; i < count; i++) {
    uint32_t sym_index = indirect_symbol_indices[i];
    if (sym_index == INDIRECT_SYMBOL_ABS || sym_index == INDIRECT_SYMBOL_LOCAL ||
        sym_index == (INDIRECT_SYMBOL_ABS | INDIRECT_SYMBOL_LOCAL)) {
      continue;
    }

    uint32_t strx = symtab[sym_index].n_un.n_strx;
    if (strx == 0) {
      continue;
    }
    char *symname = strtab + strx;
    if (symname[0] == '_') {
      symname++;
    }

    for (struct rebindings_entry *cur = rebindings; cur; cur = cur->next) {
      for (size_t j = 0; j < cur->rebindings_nel; j++) {
        if (strcmp(symname, cur->rebindings[j].name) != 0) {
          continue;
        }

        if (cur->rebindings[j].replaced && *(cur->rebindings[j].replaced) == NULL) {
          *(cur->rebindings[j].replaced) = indirect_symbol_bindings[i];
        }

        // __DATA_CONST is read-only; use COPY to allow writing.
        vm_address_t addr = (vm_address_t)((uintptr_t)indirect_symbol_bindings);
        vm_size_t size = (vm_size_t)section->size;
        kern_return_t kr =
            vm_protect(mach_task_self(), addr, size, false, VM_PROT_READ | VM_PROT_WRITE | VM_PROT_COPY);
        if (kr != KERN_SUCCESS) {
          // Avoid crashing the host process if we can't change protection.
          continue;
        }

        indirect_symbol_bindings[i] = cur->rebindings[j].replacement;
        goto next_symbol;
      }
    }
  next_symbol:
    (void)0;
  }
}

static void rebind_symbols_for_image(const struct mach_header *header, intptr_t slide) {
  Dl_info info;
  if (dladdr(header, &info) == 0) {
    return;
  }

  segment_command_t *cur_seg_cmd;
  segment_command_t *linkedit_segment = NULL;
  struct symtab_command *symtab_cmd = NULL;
  struct dysymtab_command *dysymtab_cmd = NULL;

  uintptr_t cur = (uintptr_t)header + sizeof(mach_header_t);
  for (uint32_t i = 0; i < header->ncmds; i++) {
    struct load_command *load_cmd = (struct load_command *)cur;
    if (load_cmd->cmd == LC_SEGMENT_ARCH_DEPENDENT) {
      cur_seg_cmd = (segment_command_t *)cur;
      if (strcmp(cur_seg_cmd->segname, SEG_LINKEDIT) == 0) {
        linkedit_segment = cur_seg_cmd;
      }
    } else if (load_cmd->cmd == LC_SYMTAB) {
      symtab_cmd = (struct symtab_command *)cur;
    } else if (load_cmd->cmd == LC_DYSYMTAB) {
      dysymtab_cmd = (struct dysymtab_command *)cur;
    }
    cur += load_cmd->cmdsize;
  }

  if (!linkedit_segment || !symtab_cmd || !dysymtab_cmd) {
    return;
  }

  uintptr_t linkedit_base =
      (uintptr_t)slide + linkedit_segment->vmaddr - linkedit_segment->fileoff;
  nlist_t *symtab = (nlist_t *)(linkedit_base + symtab_cmd->symoff);
  char *strtab = (char *)(linkedit_base + symtab_cmd->stroff);
  uint32_t *indirect_symtab = (uint32_t *)(linkedit_base + dysymtab_cmd->indirectsymoff);

  cur = (uintptr_t)header + sizeof(mach_header_t);
  for (uint32_t i = 0; i < header->ncmds; i++) {
    struct load_command *load_cmd = (struct load_command *)cur;
    if (load_cmd->cmd == LC_SEGMENT_ARCH_DEPENDENT) {
      cur_seg_cmd = (segment_command_t *)cur;
      if (strcmp(cur_seg_cmd->segname, SEG_DATA) != 0 &&
          strcmp(cur_seg_cmd->segname, "__DATA_CONST") != 0) {
        cur += load_cmd->cmdsize;
        continue;
      }

      for (uint32_t j = 0; j < cur_seg_cmd->nsects; j++) {
        section_t *sect = (section_t *)(cur + sizeof(segment_command_t) + sizeof(section_t) * j);
        perform_rebinding_with_section(rebindings_head, sect, slide, symtab, strtab, indirect_symtab);
      }
    }
    cur += load_cmd->cmdsize;
  }
}

static int rebind_symbols(struct rebinding rebindings[], size_t nel) {
  int retval = prepend_rebindings(&rebindings_head, rebindings, nel);
  if (retval < 0) {
    return retval;
  }

  static bool registered = false;
  if (!registered) {
    registered = true;
    _dyld_register_func_for_add_image(rebind_symbols_for_image);
  }

  uint32_t image_count = _dyld_image_count();
  for (uint32_t i = 0; i < image_count; i++) {
    rebind_symbols_for_image(_dyld_get_image_header(i), _dyld_get_image_vmaddr_slide(i));
  }
  return 0;
}

// ---- Dumper logic ----

static int (*orig_sqlite3_key)(sqlite3 *db, const void *pKey, int nKey) = NULL;
static int (*orig_sqlite3_key_v2)(sqlite3 *db, const char *zDbName, const void *pKey, int nKey) =
    NULL;
static const char *(*sqlite3_db_filename_fn)(sqlite3 *db, const char *zDbName) = NULL;

static int (*orig_sqlite3_prepare_v2)(sqlite3 *db, const char *zSql, int nByte, sqlite3_stmt **ppStmt,
                                      const char **pzTail) = NULL;
static int (*orig_sqlite3_prepare_v3)(sqlite3 *db, const char *zSql, int nByte, unsigned int prepFlags,
                                      sqlite3_stmt **ppStmt, const char **pzTail) = NULL;
static int (*orig_sqlite3_prepare16_v2)(sqlite3 *db, const void *zSql, int nByte, sqlite3_stmt **ppStmt,
                                        const void **pzTail) = NULL;
static int (*orig_sqlite3_prepare16_v3)(sqlite3 *db, const void *zSql, int nByte, unsigned int prepFlags,
                                        sqlite3_stmt **ppStmt, const void **pzTail) = NULL;
static int (*orig_sqlite3_exec)(sqlite3 *db, const char *sql,
                                int (*callback)(void *, int, char **, char **), void *arg,
                                char **errmsg) = NULL;
static int (*sqlite3_step_fn)(sqlite3_stmt *pStmt) = NULL;
static const unsigned char *(*sqlite3_column_text_fn)(sqlite3_stmt *pStmt, int iCol) = NULL;
static int (*sqlite3_finalize_fn)(sqlite3_stmt *pStmt) = NULL;
static const char *(*sqlite3_errmsg_fn)(sqlite3 *db) = NULL;

static int (*orig_CCKeyDerivationPBKDF)(CCPBKDFAlgorithm algorithm, const char *password,
                                        size_t passwordLen, const uint8_t *salt, size_t saltLen,
                                        CCPseudoRandomAlgorithm prf, uint32_t rounds,
                                        uint8_t *derivedKey, size_t derivedKeyLen) = NULL;

static void log_line(const char *fmt, ...) {
  const char *log_path = getenv("EXPORT_WECHAT_EMOJI_KEY_LOG");
  if (!log_path || !log_path[0]) {
    return;
  }
  int fd = open(log_path, O_WRONLY | O_CREAT | O_APPEND, 0600);
  if (fd < 0) {
    return;
  }
  va_list ap;
  va_start(ap, fmt);
  vdprintf(fd, fmt, ap);
  va_end(ap);
  dprintf(fd, "\n");
  close(fd);
}

static bool ends_with(const char *s, const char *suffix) {
  if (!s || !suffix) {
    return false;
  }
  const size_t n = strlen(s);
  const size_t m = strlen(suffix);
  return n >= m && memcmp(s + (n - m), suffix, m) == 0;
}

static bool is_emoticon_db(const char *path) {
  if (!path) {
    return false;
  }
  // WeChat v4: .../db_storage/emoticon/emoticon.db
  return strstr(path, "/db_storage/emoticon/emoticon.db") != NULL ||
         ends_with(path, "/emoticon.db") || ends_with(path, "emoticon.db");
}

struct db_salt_entry {
  uint8_t salt[16];
  uint8_t mac_salt[16];
  char wxid[PATH_MAX];
};

static struct db_salt_entry *g_emoticon_salts = NULL;
static size_t g_emoticon_salts_len = 0;

static const char *target_wxid_from_env(void) {
  const char *wxid = getenv("EXPORT_WECHAT_EMOJI_TARGET_WXID");
  if (!wxid || !wxid[0]) {
    return NULL;
  }
  return wxid;
}

static bool should_ignore_top_level_dir(const char *name) {
  if (!name || !name[0]) {
    return true;
  }
  if (name[0] == '.') {
    return true;
  }
  return strcmp(name, "all_users") == 0 || strcmp(name, "Backup") == 0 ||
         strcmp(name, "WMPF") == 0 || strcmp(name, "AppletCaches") == 0 ||
         strcmp(name, "Update") == 0;
}

static void load_emoticon_db_salts(void) {
  if (g_emoticon_salts) {
    return;
  }

  const char *home = getenv("HOME");
  if (!home || !home[0]) {
    return;
  }

  const char *target_wxid = target_wxid_from_env();

  char base[PATH_MAX];
  snprintf(base, sizeof(base),
           "%s/Library/Containers/com.tencent.xinWeChat/Data/Documents/xwechat_files", home);

  DIR *dir = opendir(base);
  if (!dir) {
    return;
  }

  struct dirent *ent;
  while ((ent = readdir(dir)) != NULL) {
    if (should_ignore_top_level_dir(ent->d_name)) {
      continue;
    }

    char db_path[PATH_MAX];
    snprintf(db_path, sizeof(db_path),
             "%s/%s/db_storage/emoticon/emoticon.db", base, ent->d_name);
    int fd = open(db_path, O_RDONLY);
    if (fd < 0) {
      continue;
    }
    uint8_t salt[16];
    ssize_t n = read(fd, salt, sizeof(salt));
    close(fd);
    if (n != (ssize_t)sizeof(salt)) {
      continue;
    }

    struct db_salt_entry entry = {0};
    memcpy(entry.salt, salt, 16);
    for (int i = 0; i < 16; i++) {
      entry.mac_salt[i] = salt[i] ^ 0x3a;
    }
    snprintf(entry.wxid, sizeof(entry.wxid), "%s", ent->d_name);

    struct db_salt_entry *new_list =
        (struct db_salt_entry *)realloc(g_emoticon_salts, sizeof(struct db_salt_entry) * (g_emoticon_salts_len + 1));
    if (!new_list) {
      break;
    }
    g_emoticon_salts = new_list;
    g_emoticon_salts[g_emoticon_salts_len++] = entry;
  }

  closedir(dir);

  log_line("[init] loaded emoticon.db salts: %zu%s%s", g_emoticon_salts_len,
           target_wxid ? " target_wxid=" : "",
           target_wxid ? target_wxid : "");
}

static bool salt_matches(const uint8_t *a, const uint8_t *b, size_t len) {
  return a && b && memcmp(a, b, len) == 0;
}

static void hex_encode(const uint8_t *in, size_t len, char *out, size_t out_size) {
  static const char *hex = "0123456789abcdef";
  if (out_size < (len * 2 + 1)) {
    return;
  }
  for (size_t i = 0; i < len; i++) {
    out[i * 2] = hex[(in[i] >> 4) & 0xF];
    out[i * 2 + 1] = hex[in[i] & 0xF];
  }
  out[len * 2] = '\0';
}

static bool write_text_file(const char *out_path, const char *text) {
  if (!out_path || !out_path[0] || !text || !text[0]) {
    return false;
  }
  const int fd = open(out_path, O_WRONLY | O_CREAT | O_TRUNC, 0600);
  if (fd < 0) {
    return false;
  }
  dprintf(fd, "%s\n", text);
  close(fd);
  return true;
}

static bool write_key_file(const char *out_path, const char *key_hex) {
  return write_text_file(out_path, key_hex);
}

static bool write_key_wxid_file(const char *wxid) {
  const char *out_path = getenv("EXPORT_WECHAT_EMOJI_KEY_WXID_OUT");
  if (!out_path || !out_path[0]) {
    return true;
  }
  return write_text_file(out_path, wxid);
}

static void maybe_dump_key_from_pbkdf2(const char *password, size_t password_len, const uint8_t *salt,
                                      size_t salt_len, uint32_t rounds, CCPseudoRandomAlgorithm prf) {
  static int dumped = 0;
  if (dumped) {
    return;
  }
  const char *out_path = getenv("EXPORT_WECHAT_EMOJI_KEY_OUT");
  if (!out_path || !out_path[0]) {
    return;
  }
  if (!password || password_len == 0 || !salt || salt_len != 16) {
    return;
  }

  load_emoticon_db_salts();
  if (g_emoticon_salts_len == 0) {
    return;
  }

  const struct db_salt_entry *matched_kdf_entry = NULL;
  const struct db_salt_entry *matched_mac_entry = NULL;
  for (size_t i = 0; i < g_emoticon_salts_len; i++) {
    if (salt_matches(salt, g_emoticon_salts[i].salt, 16)) {
      matched_kdf_entry = &g_emoticon_salts[i];
    }
    if (salt_matches(salt, g_emoticon_salts[i].mac_salt, 16)) {
      matched_mac_entry = &g_emoticon_salts[i];
    }
  }
  if (!matched_kdf_entry && !matched_mac_entry) {
    return;
  }

  // SQLCipher has two PBKDF2 patterns:
  // 1) KDF (large rounds): password = db passphrase, salt = kdf_salt
  // 2) fast-kdf (rounds==2): password = derived encryption key, salt = (kdf_salt ^ 0x3a)
  //
  // We accept either output as "db key" and let the Rust side try both strategies.
  if (password_len == 32) {
    char key_hex[65];
    hex_encode((const uint8_t *)password, 32, key_hex, sizeof(key_hex));
    if (matched_kdf_entry && rounds > 2) {
      log_line("[hit] PBKDF2 kdf_salt rounds=%u prf=%d pass_len=32 wxid=%s key=%s", rounds,
               (int)prf, matched_kdf_entry->wxid, key_hex);
      if (write_key_wxid_file(matched_kdf_entry->wxid) && write_key_file(out_path, key_hex)) {
        dumped = 1;
      }
      return;
    }
    if (matched_mac_entry && rounds <= 2) {
      log_line("[hit] PBKDF2 mac_salt rounds=%u prf=%d pass_len=32 wxid=%s key=%s", rounds,
               (int)prf, matched_mac_entry->wxid, key_hex);
      if (write_key_wxid_file(matched_mac_entry->wxid) && write_key_file(out_path, key_hex)) {
        dumped = 1;
      }
      return;
    }
  }

  // If it's a 64-hex ASCII string, normalize to lowercase and write as-is (only meaningful for kdf_salt).
  if (password_len == 64 && matched_kdf_entry && rounds > 2) {
    const char *s = password;
    char key_hex[65];
    for (size_t i = 0; i < 64; i++) {
      const char c = s[i];
      const bool is_hex =
          (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F');
      if (!is_hex) {
        return;
      }
      key_hex[i] = (c >= 'A' && c <= 'F') ? (char)(c - 'A' + 'a') : c;
    }
    key_hex[64] = '\0';
    log_line("[hit] PBKDF2 kdf_salt rounds=%u prf=%d pass_len=64 wxid=%s key=%s", rounds,
             (int)prf, matched_kdf_entry->wxid, key_hex);
    if (write_key_wxid_file(matched_kdf_entry->wxid) && write_key_file(out_path, key_hex)) {
      dumped = 1;
    }
    return;
  }

  log_line(
      "[skip] PBKDF2 matched emoticon salt but unsupported params: rounds=%u prf=%d pass_len=%zu (kdf_salt=%d mac_salt=%d)",
      rounds, (int)prf, password_len, matched_kdf_entry ? 1 : 0, matched_mac_entry ? 1 : 0);
}

struct url_list {
  char **items;
  size_t len;
  size_t cap;
};

static void url_list_free(struct url_list *list) {
  if (!list) {
    return;
  }
  for (size_t i = 0; i < list->len; i++) {
    free(list->items[i]);
  }
  free(list->items);
  list->items = NULL;
  list->len = 0;
  list->cap = 0;
}

static bool url_list_contains(const struct url_list *list, const char *s) {
  if (!list || !s) {
    return false;
  }
  for (size_t i = 0; i < list->len; i++) {
    if (strcmp(list->items[i], s) == 0) {
      return true;
    }
  }
  return false;
}

static void url_list_push_unique(struct url_list *list, const char *s) {
  if (!list || !s || !s[0]) {
    return;
  }
  if (url_list_contains(list, s)) {
    return;
  }
  if (list->len == list->cap) {
    size_t new_cap = list->cap ? (list->cap * 2) : 64;
    char **new_items = (char **)realloc(list->items, sizeof(char *) * new_cap);
    if (!new_items) {
      return;
    }
    list->items = new_items;
    list->cap = new_cap;
  }
  list->items[list->len++] = strdup(s);
}

static bool is_url_end_char(char c) {
  return c == '\0' || c == ' ' || c == '\t' || c == '\r' || c == '\n' || c == '"' || c == '\'' ||
         c == '<' || c == '>' || c == '\\';
}

static void url_list_add_from_text(struct url_list *out, const char *text) {
  if (!out || !text) {
    return;
  }
  const char *p = text;
  while (*p) {
    const char *http = strstr(p, "http://");
    const char *https = strstr(p, "https://");
    const char *start = NULL;
    if (http && https) {
      start = (http < https) ? http : https;
    } else {
      start = http ? http : https;
    }
    if (!start) {
      break;
    }
    const char *end = start;
    while (*end && !is_url_end_char(*end)) {
      end++;
    }
    if (end > start) {
      size_t n = (size_t)(end - start);
      char *tmp = (char *)malloc(n + 1);
      if (tmp) {
        memcpy(tmp, start, n);
        tmp[n] = '\0';
        url_list_push_unique(out, tmp);
        free(tmp);
      }
    }
    p = end;
  }
}

static bool write_urls_file(const char *out_path, const struct url_list *urls) {
  if (!out_path || !out_path[0] || !urls || urls->len == 0) {
    return false;
  }
  const int fd = open(out_path, O_WRONLY | O_CREAT | O_TRUNC, 0600);
  if (fd < 0) {
    return false;
  }
  for (size_t i = 0; i < urls->len; i++) {
    dprintf(fd, "%s\n", urls->items[i]);
  }
  close(fd);
  return true;
}

static int collect_urls_from_query(sqlite3 *db, const char *sql, struct url_list *urls) {
  if (!db || !sql || !urls) {
    return 0;
  }
  if (!orig_sqlite3_prepare_v2 || !sqlite3_step_fn || !sqlite3_column_text_fn || !sqlite3_finalize_fn) {
    return 0;
  }

  sqlite3_stmt *stmt = NULL;
  int rc = orig_sqlite3_prepare_v2(db, sql, -1, &stmt, NULL);
  if (rc != SQLITE_OK || !stmt) {
    const char *err = sqlite3_errmsg_fn ? sqlite3_errmsg_fn(db) : NULL;
    log_line("[urls] prepare failed rc=%d err=%s sql=%s", rc, err ? err : "(null)", sql);
    return 0;
  }

  size_t before = urls->len;
  while ((rc = sqlite3_step_fn(stmt)) == SQLITE_ROW) {
    // We only need the first 5 columns for our queries; ignore extras.
    for (int i = 0; i < 5; i++) {
      const unsigned char *t = sqlite3_column_text_fn(stmt, i);
      if (t && t[0]) {
        url_list_add_from_text(urls, (const char *)t);
      }
    }
  }
  if (rc != SQLITE_DONE) {
    const char *err = sqlite3_errmsg_fn ? sqlite3_errmsg_fn(db) : NULL;
    log_line("[urls] step ended rc=%d err=%s", rc, err ? err : "(null)");
  }
  sqlite3_finalize_fn(stmt);
  return (int)(urls->len - before);
}

static void maybe_dump_urls(sqlite3 *db) {
  static int dumped = 0;
  static int saw_emoticon_handle = 0;
  if (dumped) {
    return;
  }

  const char *out_path = getenv("EXPORT_WECHAT_EMOJI_URL_OUT");
  if (!out_path || !out_path[0]) {
    return;
  }
  if (!db) {
    return;
  }

  // WeChat v4 often uses a single SQLite connection and ATTACH-es multiple db files with schema
  // names like: session/contact/message/emoticon/...
  // So the emoticon db may not be the "main" database for this sqlite3* handle.
  const char *filename_main = sqlite3_db_filename_fn ? sqlite3_db_filename_fn(db, "main") : NULL;
  const char *filename_emoticon =
      sqlite3_db_filename_fn ? sqlite3_db_filename_fn(db, "emoticon") : NULL;

  const char *schema = NULL;
  const char *filename = NULL;
  if (is_emoticon_db(filename_main)) {
    schema = NULL; // main schema
    filename = filename_main;
  } else if (is_emoticon_db(filename_emoticon)) {
    schema = "emoticon";
    filename = filename_emoticon;
  } else {
    return;
  }

  // WeChat executes a *lot* of SQL during startup. Only count attempts once we've identified the
  // target db, otherwise we can "burn" the attempt budget before the user opens the emoji panel.
  static int attempts = 0;
  if (attempts++ > 500) {
    return;
  }

  if (!saw_emoticon_handle) {
    saw_emoticon_handle = 1;
    log_line("[urls] saw emoticon db handle (prog=%s) file=%s", getprogname(),
             filename ? filename : "(null)");
  }

  // WeChat v4 may access the emoticon db in WeChatAppEx rather than the main WeChat process.
  // It's OK if multiple processes race to write; the scripts only care that the file appears.

  struct url_list urls = {0};

  const char *order_tables[] = {"kCustomEmoticonOrderTable", "kFavEmoticonOrderTable"};
  for (size_t i = 0; i < sizeof(order_tables) / sizeof(order_tables[0]); i++) {
    char sql[512];
    const char *prefix = (schema && schema[0]) ? schema : NULL;
    snprintf(sql, sizeof(sql),
             "SELECT n.thumb_url, n.tp_url, n.cdn_url, n.extern_url, n.encrypt_url "
             "FROM %s%s%s o LEFT JOIN %s%skNonStoreEmoticonTable n ON o.md5 = n.md5",
             prefix ? prefix : "", prefix ? "." : "", order_tables[i], prefix ? prefix : "",
             prefix ? "." : "");
    collect_urls_from_query(db, sql, &urls);
  }

  if (urls.len == 0) {
    collect_urls_from_query(
        db,
        (schema && schema[0])
            ? "SELECT thumb_url, tp_url, cdn_url, extern_url, encrypt_url FROM emoticon.kNonStoreEmoticonTable"
            : "SELECT thumb_url, tp_url, cdn_url, extern_url, encrypt_url FROM kNonStoreEmoticonTable",
        &urls);
  }

  if (urls.len == 0) {
    url_list_free(&urls);
    return;
  }

  log_line("[urls] collected %zu urls from %s", urls.len, filename ? filename : "(null)");
  if (write_urls_file(out_path, &urls)) {
    dumped = 1;
    log_line("[urls] wrote: %s", out_path);
  }
  url_list_free(&urls);
}

static void maybe_dump_key(sqlite3 *db, const char *zDbName, const void *pKey, int nKey) {
  static int dumped = 0;
  if (dumped) {
    return;
  }
  const char *out_path = getenv("EXPORT_WECHAT_EMOJI_KEY_OUT");
  if (!out_path || !out_path[0]) {
    return;
  }
  if (!db || !pKey || nKey <= 0) {
    return;
  }

  const char *db_name = (zDbName && zDbName[0]) ? zDbName : "main";
  const char *filename =
      sqlite3_db_filename_fn ? sqlite3_db_filename_fn(db, db_name) : NULL;
  if (!is_emoticon_db(filename)) {
    log_line("[skip] sqlite3_key db=%s file=%s nKey=%d", db_name, filename ? filename : "(null)",
             nKey);
    return;
  }

  // If it's a raw 32-byte key, write 64-hex.
  if (nKey == 32) {
    char key_hex[65];
    hex_encode((const uint8_t *)pKey, 32, key_hex, sizeof(key_hex));
    log_line("[hit] emoticon.db nKey=32 key=%s", key_hex);
    if (write_key_file(out_path, key_hex)) {
      dumped = 1;
    }
    return;
  }

  // If it's a 64-hex ASCII string, normalize to lowercase and write as-is.
  if (nKey == 64) {
    const char *s = (const char *)pKey;
    char key_hex[65];
    for (int i = 0; i < 64; i++) {
      const char c = s[i];
      const bool is_hex = (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F');
      if (!is_hex) {
        log_line("[skip] emoticon.db nKey=64 but not hex");
        return;
      }
      key_hex[i] = (c >= 'A' && c <= 'F') ? (char)(c - 'A' + 'a') : c;
    }
    key_hex[64] = '\0';
    log_line("[hit] emoticon.db nKey=64 key=%s", key_hex);
    if (write_key_file(out_path, key_hex)) {
      dumped = 1;
    }
    return;
  }

  // Unknown key format: log and ignore for now (to keep UX consistent with 64-hex expectation).
  log_line("[skip] emoticon.db unsupported key length nKey=%d", nKey);
}

static int hook_sqlite3_key(sqlite3 *db, const void *pKey, int nKey) {
  maybe_dump_key(db, "main", pKey, nKey);
  int (*fn)(sqlite3 *, const void *, int) = orig_sqlite3_key;
  if (!fn) {
    fn = (int (*)(sqlite3 *, const void *, int))dlsym(RTLD_DEFAULT, "sqlite3_key");
  }
  return fn ? fn(db, pKey, nKey) : SQLITE_OK;
}

static int hook_sqlite3_key_v2(sqlite3 *db, const char *zDbName, const void *pKey, int nKey) {
  maybe_dump_key(db, zDbName, pKey, nKey);
  int (*fn)(sqlite3 *, const char *, const void *, int) = orig_sqlite3_key_v2;
  if (!fn) {
    fn = (int (*)(sqlite3 *, const char *, const void *, int))dlsym(RTLD_DEFAULT, "sqlite3_key_v2");
  }
  return fn ? fn(db, zDbName, pKey, nKey) : SQLITE_OK;
}

static int hook_sqlite3_prepare_v2(sqlite3 *db, const char *zSql, int nByte, sqlite3_stmt **ppStmt,
                                   const char **pzTail) {
  int (*fn)(sqlite3 *, const char *, int, sqlite3_stmt **, const char **) = orig_sqlite3_prepare_v2;
  if (!fn) {
    fn = (int (*)(sqlite3 *, const char *, int, sqlite3_stmt **, const char **))dlsym(
        RTLD_DEFAULT, "sqlite3_prepare_v2");
  }
  int rc = fn ? fn(db, zSql, nByte, ppStmt, pzTail) : 21 /* SQLITE_MISUSE */;
  if (rc == SQLITE_OK) {
    maybe_dump_urls(db);
  }
  return rc;
}

static int hook_sqlite3_prepare_v3(sqlite3 *db, const char *zSql, int nByte, unsigned int prepFlags,
                                   sqlite3_stmt **ppStmt, const char **pzTail) {
  int (*fn)(sqlite3 *, const char *, int, unsigned int, sqlite3_stmt **, const char **) =
      orig_sqlite3_prepare_v3;
  if (!fn) {
    fn = (int (*)(sqlite3 *, const char *, int, unsigned int, sqlite3_stmt **, const char **))dlsym(
        RTLD_DEFAULT, "sqlite3_prepare_v3");
  }
  int rc = fn ? fn(db, zSql, nByte, prepFlags, ppStmt, pzTail) : 21 /* SQLITE_MISUSE */;
  if (rc == SQLITE_OK) {
    maybe_dump_urls(db);
  }
  return rc;
}

static int hook_sqlite3_prepare16_v2(sqlite3 *db, const void *zSql, int nByte, sqlite3_stmt **ppStmt,
                                     const void **pzTail) {
  int (*fn)(sqlite3 *, const void *, int, sqlite3_stmt **, const void **) = orig_sqlite3_prepare16_v2;
  if (!fn) {
    fn = (int (*)(sqlite3 *, const void *, int, sqlite3_stmt **, const void **))dlsym(
        RTLD_DEFAULT, "sqlite3_prepare16_v2");
  }
  int rc = fn ? fn(db, zSql, nByte, ppStmt, pzTail) : 21 /* SQLITE_MISUSE */;
  if (rc == SQLITE_OK) {
    maybe_dump_urls(db);
  }
  return rc;
}

static int hook_sqlite3_prepare16_v3(sqlite3 *db, const void *zSql, int nByte, unsigned int prepFlags,
                                     sqlite3_stmt **ppStmt, const void **pzTail) {
  int (*fn)(sqlite3 *, const void *, int, unsigned int, sqlite3_stmt **, const void **) =
      orig_sqlite3_prepare16_v3;
  if (!fn) {
    fn = (int (*)(sqlite3 *, const void *, int, unsigned int, sqlite3_stmt **, const void **))dlsym(
        RTLD_DEFAULT, "sqlite3_prepare16_v3");
  }
  int rc = fn ? fn(db, zSql, nByte, prepFlags, ppStmt, pzTail) : 21 /* SQLITE_MISUSE */;
  if (rc == SQLITE_OK) {
    maybe_dump_urls(db);
  }
  return rc;
}

static int hook_sqlite3_exec(sqlite3 *db, const char *sql, int (*callback)(void *, int, char **, char **),
                             void *arg, char **errmsg) {
  int (*fn)(sqlite3 *, const char *, int (*)(void *, int, char **, char **), void *, char **) =
      orig_sqlite3_exec;
  if (!fn) {
    fn = (int (*)(sqlite3 *, const char *, int (*)(void *, int, char **, char **), void *, char **))dlsym(
        RTLD_DEFAULT, "sqlite3_exec");
  }
  int rc = fn ? fn(db, sql, callback, arg, errmsg) : 21 /* SQLITE_MISUSE */;
  if (rc == SQLITE_OK) {
    maybe_dump_urls(db);
  }
  return rc;
}

static int hook_CCKeyDerivationPBKDF(CCPBKDFAlgorithm algorithm, const char *password,
                                     size_t passwordLen, const uint8_t *salt, size_t saltLen,
                                     CCPseudoRandomAlgorithm prf, uint32_t rounds,
                                     uint8_t *derivedKey, size_t derivedKeyLen) {
  // Try to extract the db key from SQLCipher-like PBKDF2 calls (more reliable than sqlite3_key hooks).
  if (algorithm == kCCPBKDF2) {
    static int pbkdf2_log_count = 0;
    if (pbkdf2_log_count < 20) {
      char salt_hex[33] = {0};
      if (salt && saltLen == 16) {
        hex_encode(salt, 16, salt_hex, sizeof(salt_hex));
      }
      log_line("[pbkdf2] prog=%s pass_len=%zu salt_len=%zu dk_len=%zu rounds=%u prf=%d salt=%s",
               getprogname(), passwordLen, saltLen, derivedKeyLen, rounds, (int)prf,
               (salt && saltLen == 16) ? salt_hex : "-");
      pbkdf2_log_count++;
    }

    if (saltLen == 16) {
      maybe_dump_key_from_pbkdf2(password, passwordLen, salt, saltLen, rounds, prf);
    }
  }
  int (*fn)(CCPBKDFAlgorithm, const char *, size_t, const uint8_t *, size_t, CCPseudoRandomAlgorithm,
            uint32_t, uint8_t *, size_t) = orig_CCKeyDerivationPBKDF;
  if (!fn) {
    fn = (int (*)(CCPBKDFAlgorithm, const char *, size_t, const uint8_t *, size_t, CCPseudoRandomAlgorithm,
                  uint32_t, uint8_t *, size_t))dlsym(RTLD_DEFAULT, "CCKeyDerivationPBKDF");
  }
  return fn ? fn(algorithm, password, passwordLen, salt, saltLen, prf, rounds, derivedKey, derivedKeyLen)
            : -1;
}

__attribute__((constructor)) static void init_key_dumper(void) {
  sqlite3_db_filename_fn =
      (const char *(*)(sqlite3 *, const char *))dlsym(RTLD_DEFAULT, "sqlite3_db_filename");
  sqlite3_step_fn = (int (*)(sqlite3_stmt *))dlsym(RTLD_DEFAULT, "sqlite3_step");
  sqlite3_column_text_fn =
      (const unsigned char *(*)(sqlite3_stmt *, int))dlsym(RTLD_DEFAULT, "sqlite3_column_text");
  sqlite3_finalize_fn = (int (*)(sqlite3_stmt *))dlsym(RTLD_DEFAULT, "sqlite3_finalize");
  sqlite3_errmsg_fn = (const char *(*)(sqlite3 *))dlsym(RTLD_DEFAULT, "sqlite3_errmsg");

  log_line(
      "[init] key_dumper loaded (prog=%s sqlite3_db_filename=%p sqlite3_step=%p sqlite3_column_text=%p sqlite3_finalize=%p)",
      getprogname(), sqlite3_db_filename_fn, sqlite3_step_fn, sqlite3_column_text_fn, sqlite3_finalize_fn);

  load_emoticon_db_salts();

  struct rebinding binds[] = {
      {"sqlite3_key", (void *)hook_sqlite3_key, (void **)&orig_sqlite3_key},
      {"sqlite3_key_v2", (void *)hook_sqlite3_key_v2, (void **)&orig_sqlite3_key_v2},
      {"sqlite3_prepare_v2", (void *)hook_sqlite3_prepare_v2, (void **)&orig_sqlite3_prepare_v2},
      {"sqlite3_prepare_v3", (void *)hook_sqlite3_prepare_v3, (void **)&orig_sqlite3_prepare_v3},
      {"sqlite3_prepare16_v2", (void *)hook_sqlite3_prepare16_v2, (void **)&orig_sqlite3_prepare16_v2},
      {"sqlite3_prepare16_v3", (void *)hook_sqlite3_prepare16_v3, (void **)&orig_sqlite3_prepare16_v3},
      {"sqlite3_exec", (void *)hook_sqlite3_exec, (void **)&orig_sqlite3_exec},
      {"CCKeyDerivationPBKDF", (void *)hook_CCKeyDerivationPBKDF, (void **)&orig_CCKeyDerivationPBKDF},
  };
  rebind_symbols(binds, sizeof(binds) / sizeof(binds[0]));

  // If fishhook couldn't locate symbol pointers (e.g. static calls), fall back to dlsym so our own
  // dumper queries can still run once we get a db handle from hooks.
  if (!orig_sqlite3_prepare_v2) {
    orig_sqlite3_prepare_v2 =
        (int (*)(sqlite3 *, const char *, int, sqlite3_stmt **, const char **))dlsym(
            RTLD_DEFAULT, "sqlite3_prepare_v2");
  }
  if (!orig_sqlite3_prepare_v3) {
    orig_sqlite3_prepare_v3 =
        (int (*)(sqlite3 *, const char *, int, unsigned int, sqlite3_stmt **, const char **))dlsym(
            RTLD_DEFAULT, "sqlite3_prepare_v3");
  }
  if (!orig_sqlite3_prepare16_v2) {
    orig_sqlite3_prepare16_v2 =
        (int (*)(sqlite3 *, const void *, int, sqlite3_stmt **, const void **))dlsym(
            RTLD_DEFAULT, "sqlite3_prepare16_v2");
  }
  if (!orig_sqlite3_prepare16_v3) {
    orig_sqlite3_prepare16_v3 =
        (int (*)(sqlite3 *, const void *, int, unsigned int, sqlite3_stmt **, const void **))dlsym(
            RTLD_DEFAULT, "sqlite3_prepare16_v3");
  }
  if (!orig_sqlite3_exec) {
    orig_sqlite3_exec =
        (int (*)(sqlite3 *, const char *, int (*)(void *, int, char **, char **), void *, char **))dlsym(
            RTLD_DEFAULT, "sqlite3_exec");
  }

  log_line(
      "[init] rebind done (orig sqlite3_key=%p sqlite3_key_v2=%p sqlite3_prepare_v2=%p sqlite3_prepare_v3=%p sqlite3_prepare16_v2=%p sqlite3_prepare16_v3=%p sqlite3_exec=%p CCKeyDerivationPBKDF=%p)",
      orig_sqlite3_key, orig_sqlite3_key_v2, orig_sqlite3_prepare_v2, orig_sqlite3_prepare_v3,
      orig_sqlite3_prepare16_v2, orig_sqlite3_prepare16_v3, orig_sqlite3_exec, orig_CCKeyDerivationPBKDF);
}
