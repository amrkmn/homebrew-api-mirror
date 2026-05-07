#!/bin/sh
set -e

TEMPLATE="/etc/nginx/templates/default.conf.template"
OUTPUT="/etc/nginx/conf.d/default.conf"

# Generate trusted proxies block
PROXIES_BLOCK=""
if [ -n "${TRUSTED_PROXIES:-}" ]; then
    OLD_IFS="$IFS"
    IFS=','
    for proxy in $TRUSTED_PROXIES; do
        proxy=$(echo "$proxy" | tr -d ' ')
        if [ -n "$proxy" ]; then
            PROXIES_BLOCK="${PROXIES_BLOCK}set_real_ip_from ${proxy};
"
        fi
    done
    IFS="$OLD_IFS"
fi

# Add real_ip directives if proxies are configured
if [ -n "$PROXIES_BLOCK" ]; then
    PROXIES_BLOCK="${PROXIES_BLOCK}real_ip_header X-Forwarded-For;
real_ip_recursive on;"
fi

# Replace placeholders and write final config
cp "$TEMPLATE" "$OUTPUT"

# Inject trusted proxies block
if [ -n "$PROXIES_BLOCK" ]; then
    ESCAPED_BLOCK=$(printf '%s\n' "$PROXIES_BLOCK" | sed -e 's/[\/&|]/\\&/g' | sed -e ':a' -e 'N' -e '$!ba' -e 's/\n/\\n/g')
    sed -i "s|#TRUSTED_PROXIES_BLOCK#|${ESCAPED_BLOCK}|" "$OUTPUT"
else
    sed -i "/#TRUSTED_PROXIES_BLOCK#/d" "$OUTPUT"
fi

echo "nginx config generated"
echo "  trusted_proxies: ${TRUSTED_PROXIES:-none}"

exec "$@"
