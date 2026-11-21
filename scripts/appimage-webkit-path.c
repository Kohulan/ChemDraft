#define _GNU_SOURCE
#include <dlfcn.h>
#include <gio/gio.h>
#include <string.h>

// Release WebKitGTK ignores WEBKIT_EXEC_PATH. Translate the bundled helper launch at the GIO
// boundary for both direct spawns and WebKit's `bwrap --args FD -- HELPER` launch. Keep GIO's
// launcher, inherited file descriptors and sandbox arguments intact.
GSubprocess *g_subprocess_launcher_spawnv(GSubprocessLauncher *launcher,
    const gchar *const *argv, GError **error)
{
    typedef GSubprocess *(*Spawn)(GSubprocessLauncher *, const gchar *const *, GError **);
    Spawn spawn = (Spawn)dlsym(RTLD_NEXT, "g_subprocess_launcher_spawnv");
    if (!spawn) {
        g_set_error_literal(error, G_IO_ERROR, G_IO_ERROR_FAILED, "Could not resolve GIO subprocess launcher");
        return NULL;
    }

    const char *directory = g_getenv("WEBKIT_EXEC_PATH");
    if (!directory || !g_path_is_absolute(directory) || !argv || !argv[0])
        return spawn(launcher, argv, error);

    size_t program = 0;
    if (g_str_has_suffix(argv[0], "/bwrap")) {
        // The sandbox's options are passed in the arguments file, before this separator.
        while (argv[program] && strcmp(argv[program], "--") != 0)
            ++program;
        if (!argv[program] || !argv[++program])
            return spawn(launcher, argv, error);
    }

    // Tauri replaces /usr with ././ in WebKit's compiled-in path and AppRun starts in APPDIR/usr.
    g_autofree char *original = g_canonicalize_filename(argv[program], "/usr");
    const char prefix[] = WEBKIT_DIRECTORY "/";
    if (!g_str_has_prefix(original, prefix))
        return spawn(launcher, argv, error);
    const char *helper = original + sizeof(prefix) - 1;
    if (strcmp(helper, "WebKitWebProcess") && strcmp(helper, "WebKitNetworkProcess") &&
        strcmp(helper, "WebKitGPUProcess"))
        return spawn(launcher, argv, error);

    size_t argc = program + 1;
    while (argv[argc])
        ++argc;
    g_autofree char *path = g_build_filename(directory, helper, NULL);
    g_autofree const gchar **absolute_argv = g_new(const gchar *, argc + 1);
    memcpy(absolute_argv, argv, (argc + 1) * sizeof(*argv));
    absolute_argv[program] = path;
    return spawn(launcher, absolute_argv, error);
}
