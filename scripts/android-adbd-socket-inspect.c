#define _GNU_SOURCE

#include <dirent.h>
#include <errno.h>
#include <inttypes.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <unistd.h>

#include <linux/vm_sockets.h>

static int fail(int error) {
  fprintf(stderr, "OPENCLAW_ADB_VSOCK_ERROR %d\n", error);
  return 1;
}

static int parse_number(const char *text, int *number) {
  if (*text == '\0') {
    return 0;
  }
  for (const char *p = text; *p != '\0'; ++p) {
    if (*p < '0' || *p > '9') {
      return 0;
    }
  }
  errno = 0;
  long value = strtol(text, NULL, 10);
  if (errno != 0 || value > INT_MAX) {
    return 0;
  }
  *number = (int)value;
  return 1;
}

static int inspect_socket(int pidfd, int target_fd) {
  int fd = (int)syscall(SYS_pidfd_getfd, pidfd, target_fd, 0);
  if (fd < 0) {
    return errno == EBADF ? 0 : -1;
  }

  int result = 0;
  int saved_errno;
  int domain;
  int type;
  socklen_t size = sizeof(domain);
  struct sockaddr_vm local = {0};
  struct sockaddr_vm peer = {0};
  struct stat metadata;

  if (getsockopt(fd, SOL_SOCKET, SO_DOMAIN, &domain, &size) < 0) {
    if (errno == ENOTSOCK) {
      goto done;
    }
    goto error;
  }
  if (domain != AF_VSOCK) {
    goto done;
  }
  size = sizeof(type);
  if (getsockopt(fd, SOL_SOCKET, SO_TYPE, &type, &size) < 0) {
    goto error;
  }
  if (type != SOCK_STREAM) {
    goto done;
  }
  size = sizeof(local);
  if (getsockname(fd, (struct sockaddr *)&local, &size) < 0) {
    goto error;
  }
  size = sizeof(peer);
  if (getpeername(fd, (struct sockaddr *)&peer, &size) < 0) {
    if (errno == ENOTCONN) {
      goto done;
    }
    goto error;
  }
  if (fstat(fd, &metadata) < 0) {
    goto error;
  }
  result = 1;
  goto done;

error:
  result = -1;
done:
  saved_errno = errno;
  // Do not retain a socket reference while the parent exercises its closure.
  if (close(fd) < 0 && result >= 0) {
    return -1;
  }
  errno = saved_errno;
  if (result == 1 &&
      printf("OPENCLAW_ADB_VSOCK %d %" PRIuMAX " %u %u %u %u\n",
             target_fd, (uintmax_t)metadata.st_ino, local.svm_cid,
             local.svm_port, peer.svm_cid, peer.svm_port) < 0) {
    errno = EIO;
    return -1;
  }
  return result;
}

int main(int argc, char **argv) {
  int pid;
  if (argc != 2 || !parse_number(argv[1], &pid) || pid == 0) {
    return fail(EINVAL);
  }
  int pidfd = (int)syscall(SYS_pidfd_open, pid, 0);
  if (pidfd < 0) {
    return fail(errno);
  }
  char path[64];
  snprintf(path, sizeof(path), "/proc/%d/fd", pid);
  DIR *directory = opendir(path);
  if (directory == NULL) {
    int error = errno;
    close(pidfd);
    return fail(error);
  }

  int error = 0;
  int matches = 0;
  for (;;) {
    errno = 0;
    struct dirent *entry = readdir(directory);
    if (entry == NULL) {
      error = errno;
      break;
    }
    int fd;
    if (!parse_number(entry->d_name, &fd)) {
      continue;
    }
    char link[64];
    ssize_t length = readlinkat(dirfd(directory), entry->d_name, link,
                               sizeof(link));
    if (length < 0) {
      if (errno == ENOENT) {
        continue;
      }
      error = errno;
      break;
    }
    if (length < 8 || memcmp(link, "socket:[", 8) != 0) {
      continue;
    }
    int result = inspect_socket(pidfd, fd);
    if (result < 0) {
      error = errno;
      break;
    }
    matches += result;
  }
  closedir(directory);
  close(pidfd);
  if (error != 0) {
    return fail(error);
  }
  if (matches == 0) {
    return fail(ENOTCONN);
  }
  return fflush(stdout) == 0 ? 0 : fail(EIO);
}
