import { EmailMessage } from "cloudflare:email";
import { createMimeMessage } from "mimetext";

// Input limit constants
const MAX_SUBJECT_LENGTH = 500;
const MAX_CONTENT_LENGTH = 100000;
const MAX_RECIPIENTS = 50;

// Cache for parsed configurations
let cachedPlatforms = null;
let cachedApiKeys = null;

export default {
  async fetch(request, env) {
    const corsOrigin = getCorsOrigin(request, env);

    // CORS preflight
    if (request.method === "OPTIONS") {
      if (!corsOrigin) {
        return new Response("Forbidden", { status: 403 });
      }
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": corsOrigin,
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, X-API-Key",
        },
      });
    }

    // CORS origin validation
    if (!corsOrigin && env.CORS_ORIGINS) {
      return jsonResponse({ error: "Origin not allowed" }, 403, null);
    }

    // Only allow POST
    if (request.method !== "POST") {
      return jsonResponse({ error: "Method not allowed" }, 405, corsOrigin);
    }

    // Validate Content-Type
    const contentType = request.headers.get("Content-Type");
    if (!contentType || !contentType.includes("application/json")) {
      return jsonResponse({ error: "Content-Type must be application/json" }, 415, corsOrigin);
    }

    try {
      // Parse JSON body with specific error handling
      let body;
      try {
        body = await request.json();
      } catch (err) {
        return jsonResponse({ error: "Invalid JSON in request body" }, 400, corsOrigin);
      }

      const { to, subject, content, html, platformId } = body;

      // Parse platform configuration
      const platforms = parsePlatforms(env.PLATFORMS);
      if (platforms === null) {
        return jsonResponse({ error: "Server configuration error" }, 500, corsOrigin);
      }
      const platformIds = Object.keys(platforms);

      // Validate platformId
      if (!platformId) {
        return jsonResponse(
          { error: `Missing required field: platformId. Available platforms: ${platformIds.join(", ")}` },
          400,
          corsOrigin
        );
      }

      // Validate platformId format (alphanumeric, underscore, hyphen only)
      if (!/^[a-zA-Z0-9_-]+$/.test(platformId)) {
        return jsonResponse(
          { error: "Invalid platformId format. Only alphanumeric characters, underscores, and hyphens are allowed." },
          400,
          corsOrigin
        );
      }

      const platformConfig = platforms[platformId];
      if (!platformConfig) {
        return jsonResponse(
          { error: `Invalid platformId: ${platformId}. Available platforms: ${platformIds.join(", ")}` },
          400,
          corsOrigin
        );
      }

      // Validate platform configuration completeness
      if (!platformConfig.senderEmail || !platformConfig.senderName || !platformConfig.mailer) {
        console.error(`Invalid platform config for ${platformId}:`, platformConfig);
        return jsonResponse({ error: "Platform configuration error" }, 500, corsOrigin);
      }

      // Validate API Key (supports platform-specific and shared keys)
      const apiKey = request.headers.get("X-API-Key");
      if (!validateApiKey(apiKey, platformId, env)) {
        return jsonResponse({ error: "Unauthorized" }, 401, corsOrigin);
      }

      // Validate required fields
      if (!to || !subject || (!content && !html)) {
        return jsonResponse(
          { error: "Missing required fields: to, subject, and content or html" },
          400,
          corsOrigin
        );
      }

      // Validate field types
      if (typeof subject !== "string") {
        return jsonResponse({ error: "Field 'subject' must be a string" }, 400, corsOrigin);
      }
      if (content && typeof content !== "string") {
        return jsonResponse({ error: "Field 'content' must be a string" }, 400, corsOrigin);
      }
      if (html && typeof html !== "string") {
        return jsonResponse({ error: "Field 'html' must be a string" }, 400, corsOrigin);
      }

      // Validate subject doesn't contain newlines (email header injection prevention)
      if (/[\r\n]/.test(subject)) {
        return jsonResponse({ error: "Subject cannot contain newline characters" }, 400, corsOrigin);
      }

      // Validate input length
      if (subject.length > MAX_SUBJECT_LENGTH) {
        return jsonResponse(
          { error: `Subject exceeds maximum length of ${MAX_SUBJECT_LENGTH} characters` },
          400,
          corsOrigin
        );
      }

      if (content && content.length > MAX_CONTENT_LENGTH) {
        return jsonResponse(
          { error: `Content exceeds maximum length of ${MAX_CONTENT_LENGTH} characters` },
          400,
          corsOrigin
        );
      }

      if (html && html.length > MAX_CONTENT_LENGTH) {
        return jsonResponse(
          { error: `HTML content exceeds maximum length of ${MAX_CONTENT_LENGTH} characters` },
          400,
          corsOrigin
        );
      }

      // Validate recipient format
      const recipients = Array.isArray(to) ? to : [to];

      if (recipients.length > MAX_RECIPIENTS) {
        return jsonResponse(
          { error: `Exceeds maximum of ${MAX_RECIPIENTS} recipients` },
          400,
          corsOrigin
        );
      }

      if (recipients.some((email) => !isValidEmail(email))) {
        return jsonResponse({ error: "Invalid email address format" }, 400, corsOrigin);
      }

      // Get corresponding Mailer binding
      const mailer = env[platformConfig.mailer];
      if (!mailer) {
        console.error(`Mailer binding not found: ${platformConfig.mailer}`);
        return jsonResponse({ error: "Platform configuration error" }, 500, corsOrigin);
      }

      // Send email to all recipients
      const results = await Promise.allSettled(
        recipients.map((recipient) =>
          sendEmail(
            mailer,
            platformConfig.senderEmail,
            platformConfig.senderName,
            recipient,
            subject,
            content,
            html,
            platformId
          )
        )
      );

      const successCount = results.filter((r) => r.status === "fulfilled").length;
      const failedCount = results.filter((r) => r.status === "rejected").length;

      const isSuccess = successCount > 0;
      const statusCode = isSuccess ? 200 : 500;

      return jsonResponse(
        {
          success: isSuccess,
          message: `Email sent: ${successCount} success, ${failedCount} failed`,
          platform: platformId,
          details: results.map((r, i) => ({
            to: recipients[i],
            status: r.status,
            error: r.status === "rejected" ? sanitizeErrorMessage(r.reason?.message) : undefined,
          })),
        },
        statusCode,
        corsOrigin
      );
    } catch (err) {
      console.error("Email sending error:", err);
      return jsonResponse({ error: "Internal server error" }, 500, corsOrigin);
    }
  },
};

/**
 * Parse platform configuration (with caching)
 * Supports both native TOML objects and JSON strings
 * Returns null if configuration is invalid
 */
function parsePlatforms(platforms) {
  if (!platforms) {
    console.error("PLATFORMS environment variable is not set");
    return null;
  }

  if (cachedPlatforms !== null) {
    return cachedPlatforms;
  }

  // If already an object (native TOML), use directly
  if (typeof platforms === "object") {
    cachedPlatforms = platforms;
    return cachedPlatforms;
  }

  // If string, parse as JSON (backward compatibility)
  try {
    cachedPlatforms = JSON.parse(platforms);
    return cachedPlatforms;
  } catch (err) {
    console.error("Failed to parse PLATFORMS config:", err);
    return null;
  }
}

/**
 * Parse API keys JSON (with caching)
 */
function parseApiKeys(apiKeysJson) {
  if (!apiKeysJson) {
    return null;
  }

  if (cachedApiKeys !== null) {
    return cachedApiKeys;
  }

  try {
    cachedApiKeys = JSON.parse(apiKeysJson);
    return cachedApiKeys;
  } catch (err) {
    console.error("Failed to parse API_KEYS config:", err);
    return null;
  }
}

/**
 * Validate API Key
 * Supports: platform-specific key (API_KEYS) and shared key (API_KEY)
 */
function validateApiKey(apiKey, platformId, env) {
  if (!apiKey) {
    return false;
  }

  // Check platform-specific key
  const apiKeys = parseApiKeys(env.API_KEYS);
  if (apiKeys && apiKeys[platformId] && timingSafeEqual(apiKey, apiKeys[platformId])) {
    return true;
  }

  // Check shared key
  if (env.API_KEY && timingSafeEqual(apiKey, env.API_KEY)) {
    return true;
  }

  return false;
}

/**
 * Send email
 */
async function sendEmail(mailer, senderEmail, senderName, to, subject, content, html, platformId) {
  const msg = createMimeMessage();
  msg.setSender({ name: senderName, addr: senderEmail });
  msg.setRecipient(to);
  msg.setSubject(subject);

  // platformId is already validated to be alphanumeric, but escape for defense-in-depth
  const escapedPlatformId = escapeHtml(platformId);
  const sourceTag = platformId ? `[Source: ${escapedPlatformId}]` : "";
  const htmlSourceTag = platformId
    ? `<div style="color: #666; font-size: 12px; margin-bottom: 16px;">[Source: ${escapedPlatformId}]</div>`
    : "";

  if (html) {
    msg.addMessage({
      contentType: "text/html",
      data: htmlSourceTag ? `${htmlSourceTag}${html}` : html,
    });
  }

  if (content) {
    msg.addMessage({
      contentType: "text/plain",
      data: sourceTag ? `${sourceTag}\n\n${content}` : content,
    });
  } else if (html) {
    msg.addMessage({
      contentType: "text/plain",
      data: sourceTag
        ? `${sourceTag}\n\nPlease use an HTML-capable email client to view this message.`
        : "Please use an HTML-capable email client to view this message.",
    });
  }

  const message = new EmailMessage(senderEmail, to, msg.asRaw());
  await mailer.send(message);
}

/**
 * Constant-time string comparison
 * Prevents timing attacks by always comparing in constant time
 */
function timingSafeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") {
    return false;
  }

  const encoder = new TextEncoder();
  const aBytes = encoder.encode(a);
  const bBytes = encoder.encode(b);

  // Return false immediately for different lengths
  // This is safe because key length is not secret (attacker can guess common lengths)
  // The important thing is that valid key comparison is constant-time
  if (aBytes.length !== bBytes.length) {
    return false;
  }

  let result = 0;
  for (let i = 0; i < aBytes.length; i++) {
    result |= aBytes[i] ^ bBytes[i];
  }
  return result === 0;
}

/**
 * Validate email address format
 * Uses stricter validation to prevent injection attacks
 */
function isValidEmail(email) {
  if (typeof email !== "string" || email.length > 254) {
    return false;
  }

  // Block newlines (SMTP header injection)
  if (/[\r\n]/.test(email)) {
    return false;
  }

  // Block consecutive dots, leading/trailing dots
  if (/\.\./.test(email) || email.startsWith(".") || email.includes(".@") || email.endsWith(".")) {
    return false;
  }

  // Stricter regex - only allow common safe characters
  return /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/.test(
    email
  );
}

/**
 * Sanitize error message
 */
function sanitizeErrorMessage(message) {
  if (!message) return "Unknown error";
  const sanitized = message
    .replace(/at\s+.*:\d+:\d+/g, "")
    .replace(/\/[\w/.-]+/g, "[path]")
    .trim();
  return sanitized || "Email sending failed";
}

/**
 * Escape HTML special characters
 */
function escapeHtml(text) {
  const map = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;",
  };
  return text.replace(/[&<>"']/g, (char) => map[char]);
}

/**
 * Get CORS origin
 */
function getCorsOrigin(request, env) {
  if (env.CORS_ORIGINS) {
    const allowedOrigins = env.CORS_ORIGINS.split(",").map((s) => s.trim());
    const requestOrigin = request.headers.get("Origin");
    if (requestOrigin && allowedOrigins.includes(requestOrigin)) {
      return requestOrigin;
    }
    return null;
  }

  if (env.CORS_ORIGIN) {
    return env.CORS_ORIGIN;
  }

  return "*";
}

/**
 * JSON response
 */
function jsonResponse(data, status = 200, corsOrigin = "*") {
  const headers = { "Content-Type": "application/json" };
  if (corsOrigin) {
    headers["Access-Control-Allow-Origin"] = corsOrigin;
  }
  return new Response(JSON.stringify(data), { status, headers });
}
