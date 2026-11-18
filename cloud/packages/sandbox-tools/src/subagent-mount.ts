export const OPEN_ENTRY = `def open_entry(name, parent=None, directory=True):
    # Check identity because some runtimes ignore O_NOFOLLOW with O_DIRECTORY.
    entry = os.stat(name, dir_fd=parent, follow_symlinks=False)
    is_expected_type = stat.S_ISDIR if directory else stat.S_ISREG
    if not is_expected_type(entry.st_mode):
        raise ValueError('unexpected entry type')
    flags = os.O_DIRECTORY if directory else os.O_NONBLOCK
    fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | flags, dir_fd=parent)
    try:
        if not os.path.samestat(entry, os.fstat(fd)):
            raise ValueError('entry changed during open')
    except (OSError, ValueError):
        os.close(fd)
        raise
    return fd
`;

// Bubblewrap verifies each descriptor against the mounted object before running the command.
export const MOUNT_LAUNCHER = `import os,stat,sys

${OPEN_ENTRY}
def open_source(path, directory):
    parts = path.split('/')
    if parts[0] != '' or any(part in ('', '.', '..') for part in parts[1:]):
        raise ValueError('expected a canonical absolute mount source')
    parent = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
    try:
        for part in parts[1:-1]:
            child = open_entry(part, parent)
            os.close(parent)
            parent = child
        return open_entry(parts[-1], parent, directory=directory)
    finally:
        os.close(parent)

mount_count = int(sys.argv[1])
argv = sys.argv[2:]
for mount in range(mount_count):
    source_index = 2 + mount * 3
    fd = open_source(argv[source_index], directory=(mount == 0))
    os.set_inheritable(fd, True)
    argv[source_index] = str(fd)
os.execvp(argv[0], argv)
`;
