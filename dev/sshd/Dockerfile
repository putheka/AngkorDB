# A throwaway SSH server for the SSH tunnel tests (ANG-43). Development only.
FROM alpine:latest
RUN apk add --no-cache openssh-server \
 && adduser -D -s /bin/sh tunnel \
 && echo 'tunnel:tunnel' | chpasswd \
 && ssh-keygen -A
COPY sshd_config /etc/ssh/sshd_config
EXPOSE 22
CMD ["/usr/sbin/sshd", "-D", "-e"]
