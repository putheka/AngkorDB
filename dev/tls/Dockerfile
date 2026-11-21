# A Postgres that insists on TLS, for the SSL tests (ANG-44). Development only.
FROM postgres:16-alpine
RUN apk add --no-cache openssl
COPY entrypoint.sh /tls-entrypoint.sh
COPY pg_hba.conf /etc/postgresql/pg_hba_tls.conf
COPY certuser.sql /docker-entrypoint-initdb.d/01-certuser.sql
ENTRYPOINT ["/tls-entrypoint.sh"]
CMD ["postgres"]
