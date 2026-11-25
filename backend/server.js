require("dotenv").config();

const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");
const bcrypt = require("bcrypt");
const multer = require("multer");
const jwt = require("jsonwebtoken");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { Resend } = require("resend");
const { createClient } = require("@supabase/supabase-js");

const app = express();

const PORT = process.env.PORT || 5000;
const JWT_SECRET = process.env.JWT_SECRET;

const RESEND_API_KEY =
  process.env.RESEND_API_KEY || "";

const RESEND_FROM_EMAIL =
  process.env.RESEND_FROM_EMAIL ||
  "onboarding@resend.dev";

const resend =
  RESEND_API_KEY
    ? new Resend(RESEND_API_KEY)
    : null;
async function sendSecurityEmail({
  to,
  subject,
  html,
}) {
  if (!resend) {
    console.error(
      "Resend is not configured. Email not sent."
    );
    return {
      success: false,
      reason: "resend_not_configured",
    };
  }

  try {
    const result =
      await resend.emails.send({
        from: RESEND_FROM_EMAIL,
        to: [to],
        subject,
        html,
      });

    if (result.error) {
      console.error(
        "Resend email error:",
        result.error.message
      );

      return {
        success: false,
        reason: "resend_error",
      };
    }

    return {
      success: true,
      id: result.data?.id || null,
    };
  } catch (error) {
    console.error(
      "Security email error:",
      error.message
    );

    return {
      success: false,
      reason: "email_send_failed",
    };
  }
}
function generateOtp() {
  return crypto
    .randomInt(100000, 1000000)
    .toString();
}

function hashResetValue(value) {
  return crypto
    .createHmac("sha256", JWT_SECRET)
    .update(value)
    .digest("hex");
}

function generateResetToken() {
  return crypto
    .randomBytes(32)
    .toString("hex");
}

function getClientIp(req) {
  return (
    req.ip ||
    req.headers["x-forwarded-for"] ||
    req.socket.remoteAddress ||
    "unknown"
  )
    .toString()
    .split(",")[0]
    .trim();
}
app.set("trust proxy", 1);

const PUBLIC_BASE_URL =
  process.env.PUBLIC_BASE_URL || "";

const SUPABASE_URL =
  process.env.SUPABASE_URL;

const SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY;

const SUPABASE_BUCKET =
  "website-images";

if (!JWT_SECRET) {
  console.error("JWT_SECRET missing in .env");
  process.exit(1);
}

if (!SUPABASE_URL) {
  console.error("SUPABASE_URL missing in .env");
  process.exit(1);
}

if (!SUPABASE_SERVICE_ROLE_KEY) {
  console.error(
    "SUPABASE_SERVICE_ROLE_KEY missing in .env"
  );
  process.exit(1);
}

const supabase = createClient(
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY
);

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const pool = new Pool({
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  password: process.env.DB_PASSWORD,
  port: process.env.DB_PORT,
});

function buildPublicUrl(req, relativePath) {
  if (!relativePath) return null;

  if (
    relativePath.startsWith("http://") ||
    relativePath.startsWith("https://")
  ) {
    return relativePath;
  }

  if (PUBLIC_BASE_URL) {
    return `${PUBLIC_BASE_URL.replace(
      /\/$/,
      ""
    )}${relativePath}`;
  }

  return `${req.protocol}://${req.get(
    "host"
  )}${relativePath}`;
}

function getStoragePathFromPublicUrl(url) {
  if (!url) return null;

  const marker =
    `/storage/v1/object/public/${SUPABASE_BUCKET}/`;

  const index = url.indexOf(marker);

  if (index === -1) {
    return null;
  }

  return decodeURIComponent(
    url.substring(index + marker.length)
  );
}

async function uploadFileToSupabase(
  localPath,
  storagePath,
  contentType
) {
  const fileBuffer =
    fs.readFileSync(localPath);

  const { error } =
    await supabase.storage
      .from(SUPABASE_BUCKET)
      .upload(
        storagePath,
        fileBuffer,
        {
          contentType,
          upsert: true,
        }
      );

  if (error) {
    throw error;
  }

  const { data } =
    supabase.storage
      .from(SUPABASE_BUCKET)
      .getPublicUrl(storagePath);

  if (!data || !data.publicUrl) {
    throw new Error(
      "Failed to generate Supabase public URL."
    );
  }

  return data.publicUrl;
}

async function deleteFromSupabase(publicUrl) {
  const storagePath =
    getStoragePathFromPublicUrl(
      publicUrl
    );

  if (!storagePath) {
    return;
  }

  const { error } =
    await supabase.storage
      .from(SUPABASE_BUCKET)
      .remove([storagePath]);

  if (error) {
    console.error(
      "Supabase delete error:",
      error.message
    );
  }
}

async function initializeDatabase() {
  const client = await pool.connect();

  try {
    console.log(
      "PostgreSQL connected successfully!"
    );

    await client.query(`
      CREATE TABLE IF NOT EXISTS site_images (
        id SERIAL PRIMARY KEY,
        image_type VARCHAR(50) UNIQUE NOT NULL,
        image_url TEXT NOT NULL,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    console.log(
      "Site images table ready."
    );

    await client.query(`
      CREATE TABLE IF NOT EXISTS gallery (
        id SERIAL PRIMARY KEY,
        title VARCHAR(150) NOT NULL,
        category VARCHAR(100) NOT NULL,
        image_url TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    console.log(
      "Gallery table ready."
    );
  } catch (error) {
    console.error(
      "Database initialization error:",
      error.message
    );
  } finally {
    client.release();
  }
}

initializeDatabase().catch((error) => {
  console.error(
    "Database initialization failed:",
    error.message
  );
});

/*
  Temporary local upload directory.

  Multer first receives the file here.
  The file is immediately uploaded to
  Supabase Storage and then deleted locally.

  Therefore Render's filesystem is NOT used
  for permanent image storage.
*/

const uploadsDir =
  path.join(__dirname, "uploads");

if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, {
    recursive: true,
  });
}

app.use(
  "/uploads",
  express.static(uploadsDir)
);

const storage =
  multer.diskStorage({
    destination: function (
      req,
      file,
      cb
    ) {
      cb(null, uploadsDir);
    },

    filename: function (
      req,
      file,
      cb
    ) {
      const ext =
        path.extname(
          file.originalname
        );

      const filename =
        `temp-${Date.now()}-${Math.round(
          Math.random() * 1e9
        )}${ext}`;

      cb(null, filename);
    },
  });

const fileFilter =
  function (req, file, cb) {
    const allowedTypes = [
      "image/jpeg",
      "image/png",
      "image/webp",
    ];

    if (
      allowedTypes.includes(
        file.mimetype
      )
    ) {
      cb(null, true);
    } else {
      cb(
        new Error(
          "Only JPG, PNG and WEBP images are allowed."
        )
      );
    }
  };

const upload =
  multer({
    storage,
    fileFilter,
    limits: {
      fileSize: 5 * 1024 * 1024,
    },
  });

async function authenticateAdmin(
  req,
  res,
  next
) {
  const authHeader =
    req.headers.authorization;

  if (!authHeader) {
    return res.status(401).json({
      success: false,
      message:
        "Authorization token missing.",
    });
  }

  const parts =
    authHeader.split(" ");

  if (
    parts.length !== 2 ||
    parts[0] !== "Bearer"
  ) {
    return res.status(401).json({
      success: false,
      message:
        "Invalid authorization token.",
    });
  }

  const token = parts[1];

  try {
    const decoded =
      jwt.verify(
        token,
        JWT_SECRET
      );

    if (
      !decoded.id ||
      typeof decoded.tokenVersion !== "number"
    ) {
      return res.status(401).json({
        success: false,
        message:
          "Invalid authorization token.",
      });
    }

    const result =
      await pool.query(
        `
        SELECT
          id,
          username,
          token_version
        FROM admin_users
        WHERE id = $1
        LIMIT 1
        `,
        [decoded.id]
      );

    if (
      result.rows.length === 0
    ) {
      return res.status(401).json({
        success: false,
        message:
          "Admin account not found.",
      });
    }

    const admin =
      result.rows[0];

    if (
      decoded.tokenVersion !==
      admin.token_version
    ) {
      return res.status(401).json({
        success: false,
        message:
          "Session expired. Please log in again.",
      });
    }

    req.admin = {
      id: admin.id,
      username: admin.username,
      tokenVersion:
        admin.token_version,
    };

    next();
  } catch (error) {
    return res.status(401).json({
      success: false,
      message:
        "Invalid or expired token.",
    });
  }
}

app.get("/", (req, res) => {
  res.json({
    success: true,
    message:
      "Shree Photo Studio backend is running.",
  });
});

app.get(
  "/api/categories",
  async (req, res) => {
    try {
      const result =
        await pool.query(`
          SELECT
            id,
            name,
            slug,
            description,
            created_at
          FROM categories
          ORDER BY id ASC
        `);

      res.json({
        success: true,
        categories:
          result.rows,
      });
    } catch (error) {
      console.error(
        "Categories error:",
        error.message
      );

      res.status(500).json({
        success: false,
        message:
          "Failed to load categories.",
      });
    }
  }
);

app.post(
  "/api/enquiries",
  async (req, res) => {
    try {
      const {
        name,
        mobile,
        service,
        preferred_date,
        requirement,
        message,
      } = req.body;

      if (!name || !mobile) {
        return res.status(400).json({
          success: false,
          message:
            "Name and mobile are required.",
        });
      }

      const result =
        await pool.query(
          `
          INSERT INTO enquiries
          (
            name,
            mobile,
            service,
            preferred_date,
            requirement,
            message,
            status
          )
          VALUES
          (
            $1,
            $2,
            $3,
            $4,
            $5,
            $6,
            'New'
          )
          RETURNING *
          `,
          [
            name,
            mobile,
            service || null,
            preferred_date || null,
            requirement || null,
            message || null,
          ]
        );

      res.status(201).json({
        success: true,
        message:
          "Enquiry submitted successfully.",
        enquiry:
          result.rows[0],
      });
    } catch (error) {
      console.error(
        "Enquiry create error:",
        error.message
      );

      res.status(500).json({
        success: false,
        message:
          "Failed to submit enquiry.",
      });
    }
  }
);

app.post(
  "/api/admin/forgot-password",
  async (req, res) => {
    try {
      const email =
        typeof req.body?.email === "string"
          ? req.body.email.trim().toLowerCase()
          : "";

      const genericResponse = {
        success: true,
        message:
          "If the recovery email is registered, an OTP has been sent.",
      };

      if (!email) {
        return res.json(genericResponse);
      }

      const adminResult =
        await pool.query(
          `
          SELECT
            id,
            username,
            recovery_email
          FROM admin_users
          WHERE LOWER(recovery_email) = $1
          LIMIT 1
          `,
          [email]
        );

      if (adminResult.rows.length === 0) {
        return res.json(genericResponse);
      }

      const admin =
        adminResult.rows[0];

      const clientIp =
        getClientIp(req);

      const rateLimitResult =
        await pool.query(
          `
          SELECT COUNT(*)::int AS count
          FROM admin_password_resets
          WHERE
            admin_id = $1
            AND created_at > NOW() - INTERVAL '15 minutes'
          `,
          [admin.id]
        );

      if (
        rateLimitResult.rows[0].count >= 3
      ) {
        return res.json(genericResponse);
      }

      const otp =
        generateOtp();

      const otpHash =
        hashResetValue(otp);

      await pool.query(
        `
        UPDATE admin_password_resets
        SET used_at = NOW()
        WHERE
          admin_id = $1
          AND used_at IS NULL
          AND verified_at IS NULL
        `,
        [admin.id]
      );

      await pool.query(
        `
        INSERT INTO admin_password_resets
        (
          admin_id,
          otp_hash,
          expires_at,
          request_ip
        )
        VALUES
        (
          $1,
          $2,
          NOW() + INTERVAL '10 minutes',
          $3
        )
        `,
        [
          admin.id,
          otpHash,
          clientIp,
        ]
      );

      const emailResult =
        await sendSecurityEmail({
          to: email,
          subject:
            "Shree Photo Studio Admin Password Reset OTP",
          html: `
            <div style="font-family:Arial,sans-serif;line-height:1.6;color:#222;">
              <h2>Admin Password Reset</h2>
              <p>
                A password reset request was made
                for your Shree Photo Studio admin account.
              </p>
              <p>Your OTP is:</p>

              <div style="
                font-size:32px;
                font-weight:700;
                letter-spacing:8px;
                margin:20px 0;
              ">
                ${otp}
              </div>

              <p>
                This OTP expires in
                <strong>10 minutes</strong>.
              </p>

              <p>
                If you did not request this,
                you can safely ignore this email.
              </p>

              <p>
                — Shree Photo Studio Security
              </p>
            </div>
          `,
        });

      if (!emailResult.success) {
        console.error(
          "Password reset email could not be sent."
        );
      }

      return res.json(genericResponse);
    } catch (error) {
      console.error(
        "Forgot-password error:",
        error.message
      );

      return res.json({
        success: true,
        message:
          "If the recovery email is registered, an OTP has been sent.",
      });
    }
  }
);
app.post(
  "/api/admin/verify-reset-otp",
  async (req, res) => {
    try {
      const email =
        typeof req.body?.email === "string"
          ? req.body.email.trim().toLowerCase()
          : "";

      const otp =
        typeof req.body?.otp === "string"
          ? req.body.otp.trim()
          : "";

      if (
        !email ||
        !/^\d{6}$/.test(otp)
      ) {
        return res.status(400).json({
          success: false,
          message:
            "Valid email and 6-digit OTP are required.",
        });
      }

      const adminResult =
        await pool.query(
          `
          SELECT
            id,
            username,
            recovery_email
          FROM admin_users
          WHERE LOWER(recovery_email) = $1
          LIMIT 1
          `,
          [email]
        );

      if (
        adminResult.rows.length === 0
      ) {
        return res.status(400).json({
          success: false,
          message:
            "Invalid or expired OTP.",
        });
      }

      const admin =
        adminResult.rows[0];

      const resetResult =
        await pool.query(
          `
          SELECT
            id,
            otp_hash,
            attempts,
            expires_at
          FROM admin_password_resets
          WHERE
            admin_id = $1
            AND used_at IS NULL
            AND verified_at IS NULL
          ORDER BY created_at DESC
          LIMIT 1
          `,
          [admin.id]
        );

      if (
        resetResult.rows.length === 0
      ) {
        return res.status(400).json({
          success: false,
          message:
            "Invalid or expired OTP.",
        });
      }

      const reset =
        resetResult.rows[0];

      if (
        new Date(reset.expires_at) <=
        new Date()
      ) {
        return res.status(400).json({
          success: false,
          message:
            "Invalid or expired OTP.",
        });
      }

      if (reset.attempts >= 5) {
        return res.status(429).json({
          success: false,
          message:
            "Too many OTP attempts. Please request a new OTP.",
        });
      }

      const submittedHash =
        hashResetValue(otp);

      if (
        submittedHash !==
        reset.otp_hash
      ) {
        await pool.query(
          `
          UPDATE admin_password_resets
          SET attempts = attempts + 1
          WHERE id = $1
          `,
          [reset.id]
        );

        return res.status(400).json({
          success: false,
          message:
            "Invalid or expired OTP.",
        });
      }

      const resetToken =
        generateResetToken();

      const resetTokenHash =
        hashResetValue(
          resetToken
        );

      await pool.query(
        `
        UPDATE admin_password_resets
        SET
          verified_at = NOW(),
          reset_token_hash = $1,
          reset_token_expires_at =
            NOW() + INTERVAL '10 minutes'
        WHERE id = $2
        `,
        [
          resetTokenHash,
          reset.id,
        ]
      );

      return res.json({
        success: true,
        message:
          "OTP verified successfully.",
        resetToken,
      });
    } catch (error) {
      console.error(
        "Verify reset OTP error:",
        error.message
      );

      return res.status(500).json({
        success: false,
        message:
          "Unable to verify OTP.",
      });
    }
  }
);
app.post(
  "/api/admin/reset-password",
  async (req, res) => {
    try {
      const email =
        typeof req.body?.email === "string"
          ? req.body.email.trim().toLowerCase()
          : "";

      const resetToken =
        typeof req.body?.resetToken === "string"
          ? req.body.resetToken.trim()
          : "";

      const newPassword =
        typeof req.body?.newPassword === "string"
          ? req.body.newPassword
          : "";

      if (
        !email ||
        !resetToken ||
        !newPassword
      ) {
        return res.status(400).json({
          success: false,
          message:
            "Email, reset token and new password are required.",
        });
      }

      if (newPassword.length < 8) {
        return res.status(400).json({
          success: false,
          message:
            "New password must be at least 8 characters long.",
        });
      }

      const adminResult =
        await pool.query(
          `
          SELECT
            id,
            username,
            recovery_email
          FROM admin_users
          WHERE LOWER(recovery_email) = $1
          LIMIT 1
          `,
          [email]
        );

      if (
        adminResult.rows.length === 0
      ) {
        return res.status(400).json({
          success: false,
          message:
            "Invalid or expired reset request.",
        });
      }

      const admin =
        adminResult.rows[0];

      const resetTokenHash =
        hashResetValue(
          resetToken
        );

      const resetResult =
        await pool.query(
          `
          SELECT
            id,
            reset_token_hash,
            reset_token_expires_at
          FROM admin_password_resets
          WHERE
            admin_id = $1
            AND verified_at IS NOT NULL
            AND used_at IS NULL
            AND reset_token_hash = $2
          ORDER BY verified_at DESC
          LIMIT 1
          `,
          [
            admin.id,
            resetTokenHash,
          ]
        );

      if (
        resetResult.rows.length === 0
      ) {
        return res.status(400).json({
          success: false,
          message:
            "Invalid or expired reset request.",
        });
      }

      const reset =
        resetResult.rows[0];

      if (
        !reset.reset_token_expires_at ||
        new Date(
          reset.reset_token_expires_at
        ) <= new Date()
      ) {
        return res.status(400).json({
          success: false,
          message:
            "Invalid or expired reset request.",
        });
      }

      const newPasswordHash =
        await bcrypt.hash(
          newPassword,
          10
        );

      await pool.query(
        `
        UPDATE admin_users
        SET
          password_hash = $1,
          token_version = token_version + 1
        WHERE id = $2
        `,
        [
          newPasswordHash,
          admin.id,
        ]
      );

      await pool.query(
        `
        UPDATE admin_password_resets
        SET
          used_at = NOW()
        WHERE id = $1
        `,
        [reset.id]
      );

      const emailResult =
        await sendSecurityEmail({
          to: email,
          subject:
            "Shree Photo Studio Admin Password Changed",
          html: `
            <div style="font-family:Arial,sans-serif;line-height:1.6;color:#222;">
              <h2>Password Changed</h2>

              <p>
                Your Shree Photo Studio admin password
                was successfully changed.
              </p>

              <p>
                For security, all existing admin sessions
                have been invalidated.
              </p>

              <p>
                If you did not make this change,
                secure your account immediately.
              </p>

              <p>
                — Shree Photo Studio Security
              </p>
            </div>
          `,
        });

      if (!emailResult.success) {
        console.error(
          "Password-change security email could not be sent."
        );
      }

      return res.json({
        success: true,
        message:
          "Password reset successfully. Please log in again.",
      });
    } catch (error) {
      console.error(
        "Reset-password error:",
        error.message
      );

      return res.status(500).json({
        success: false,
        message:
          "Unable to reset password.",
      });
    }
  }
);
app.post(
  "/api/admin/login",
  async (req, res) => {
    try {
      const {
        username,
        password,
      } = req.body;

      if (
        !username ||
        !password
      ) {
        return res.status(400).json({
          success: false,
          message:
            "Username and password are required.",
        });
      }

      const clientIp =
        getClientIp(req);

      const recentFailures =
        await pool.query(
          `
          SELECT COUNT(*)::int AS count
          FROM admin_login_attempts
          WHERE
            created_at > NOW() - INTERVAL '15 minutes'
            AND success = FALSE
            AND (
              ip_address = $1
              OR username = $2
            )
          `,
          [
            clientIp,
            username,
          ]
        );

      if (
        recentFailures.rows[0].count >= 5
      ) {
        return res.status(429).json({
          success: false,
          message:
            "Too many failed login attempts. Please try again later.",
        });
      }

      const result =
        await pool.query(
          `
          SELECT *
          FROM admin_users
          WHERE username = $1
          LIMIT 1
          `,
          [username]
        );

      if (
        result.rows.length === 0
      ) {
        await pool.query(
          `
          INSERT INTO admin_login_attempts
            (username, ip_address, success)
          VALUES ($1, $2, FALSE)
          `,
          [
            username,
            clientIp,
          ]
        );

        return res.status(401).json({
          success: false,
          message:
            "Invalid username or password.",
        });
      }

      const admin =
        result.rows[0];

      const passwordMatch =
        await bcrypt.compare(
          password,
          admin.password_hash
        );

      if (!passwordMatch) {
        await pool.query(
          `
          INSERT INTO admin_login_attempts
            (username, ip_address, success)
          VALUES ($1, $2, FALSE)
          `,
          [
            username,
            clientIp,
          ]
        );

        return res.status(401).json({
          success: false,
          message:
            "Invalid username or password.",
        });
      }

      await pool.query(
        `
        INSERT INTO admin_login_attempts
          (username, ip_address, success)
        VALUES ($1, $2, TRUE)
        `,
        [
          username,
          clientIp,
        ]
      );

      const token =
        jwt.sign(
          {
            id: admin.id,
            username:
              admin.username,
            tokenVersion:
              admin.token_version,
          },
          JWT_SECRET,
          {
            expiresIn:
              "2h",
          }
        );

      return res.json({
        success: true,
        message:
          "Login successful.",
        token,
        admin: {
          id: admin.id,
          username:
            admin.username,
        },
      });
    } catch (error) {
      console.error(
        "Admin login error:",
        error.message
      );

      return res.status(500).json({
        success: false,
        message:
          "Login failed.",
      });
    }
  }
);

app.get(
  "/api/admin/me",
  authenticateAdmin,
  async (req, res) => {
    try {
      const result =
        await pool.query(
          `
          SELECT
            id,
            username,
            created_at
          FROM admin_users
          WHERE id = $1
          LIMIT 1
          `,
          [req.admin.id]
        );

      if (
        result.rows.length === 0
      ) {
        return res.status(404).json({
          success: false,
          message:
            "Admin not found.",
        });
      }

      res.json({
        success: true,
        admin:
          result.rows[0],
      });
    } catch (error) {
      console.error(
        "Admin me error:",
        error.message
      );

      res.status(500).json({
        success: false,
        message:
          "Failed to load admin.",
      });
    }
  }
);


/* =========================
   ADMIN CHANGE PASSWORD
========================= */

app.post(
  "/api/admin/change-password",
  authenticateAdmin,
  async (req, res) => {
    try {
      const {
        currentPassword,
        newPassword,
      } = req.body;

      if (
        !currentPassword ||
        !newPassword
      ) {
        return res.status(400).json({
          success: false,
          message:
            "Current password and new password are required.",
        });
      }

      if (newPassword.length < 8) {
        return res.status(400).json({
          success: false,
          message:
            "New password must be at least 8 characters long.",
        });
      }

      if (
        currentPassword ===
        newPassword
      ) {
        return res.status(400).json({
          success: false,
          message:
            "New password must be different from current password.",
        });
      }

      const result =
        await pool.query(
          `
          SELECT
            id,
            username,
            password_hash
          FROM admin_users
          WHERE id = $1
          LIMIT 1
          `,
          [req.admin.id]
        );

      if (
        result.rows.length === 0
      ) {
        return res.status(404).json({
          success: false,
          message:
            "Admin account not found.",
        });
      }

      const admin =
        result.rows[0];

      const passwordMatch =
        await bcrypt.compare(
          currentPassword,
          admin.password_hash
        );

      if (!passwordMatch) {
        await pool.query(
          `
          INSERT INTO admin_login_attempts
            (username, ip_address, success)
          VALUES (      if (!passwordMatch) {
,         return res.status(401).json({, FALSE)
          `,
          [username, clientIp]
        );

        return res.status(401).json({
          success: false,
          message:
            "Current password is incorrect.",
        });
      }

      const newPasswordHash =
        await bcrypt.hash(
          newPassword,
          10
        );

      const passwordUpdateResult =
        await pool.query(
        `
        UPDATE admin_users
        SET
          password_hash = $1,
          token_version = token_version + 1
        WHERE id = $2
        RETURNING token_version
        `,
        [
          newPasswordHash,
          admin.id,
        ]
      );

      const newTokenVersion =
        passwordUpdateResult.rows[0].token_version;
      const newToken =
        jwt.sign(
          {
            id: admin.id,
            username:
              admin.username,
            tokenVersion:
              newTokenVersion,
          },
          JWT_SECRET,
          {
            expiresIn:
              "2h",
          }
        );

      res.json({
        success: true,
        message:
          "Password changed successfully.",
        token: newToken,
      });
    } catch (error) {
      console.error(
        "Change password error:",
        error.message
      );

      res.status(500).json({
        success: false,
        message:
          "Failed to change password.",
      });
    }
  }
);
app.get(
  "/api/enquiries",
  authenticateAdmin,
  async (req, res) => {
    try {
      const result =
        await pool.query(`
          SELECT
            id,
            name,
            mobile,
            service,
            preferred_date,
            requirement,
            message,
            status,
            created_at
          FROM enquiries
          ORDER BY created_at DESC
        `);

      res.json({
        success: true,
        enquiries:
          result.rows,
      });
    } catch (error) {
      console.error(
        "Enquiries error:",
        error.message
      );

      res.status(500).json({
        success: false,
        message:
          "Failed to load enquiries.",
      });
    }
  }
);

app.patch(
  "/api/enquiries/:id/status",
  authenticateAdmin,
  async (req, res) => {
    try {
      const enquiryId =
        req.params.id;

      const { status } =
        req.body;

      const allowedStatuses = [
        "New",
        "Contacted",
        "Completed",
      ];

      if (
        !allowedStatuses.includes(
          status
        )
      ) {
        return res.status(400).json({
          success: false,
          message:
            "Invalid status.",
        });
      }

      const result =
        await pool.query(
          `
          UPDATE enquiries
          SET status = $1
          WHERE id = $2
          RETURNING *
          `,
          [
            status,
            enquiryId,
          ]
        );

      if (
        result.rows.length === 0
      ) {
        return res.status(404).json({
          success: false,
          message:
            "Enquiry not found.",
        });
      }

      res.json({
        success: true,
        message:
          "Status updated successfully.",
        enquiry:
          result.rows[0],
      });
    } catch (error) {
      console.error(
        "Status update error:",
        error.message
      );

      res.status(500).json({
        success: false,
        message:
          "Failed to update status.",
      });
    }
  }
);

app.delete(
  "/api/enquiries/:id",
  authenticateAdmin,
  async (req, res) => {
    try {
      const enquiryId =
        req.params.id;

      const result =
        await pool.query(
          `
          DELETE FROM enquiries
          WHERE id = $1
          RETURNING *
          `,
          [enquiryId]
        );

      if (
        result.rows.length === 0
      ) {
        return res.status(404).json({
          success: false,
          message:
            "Enquiry not found.",
        });
      }

      res.json({
        success: true,
        message:
          "Enquiry deleted successfully.",
      });
    } catch (error) {
      console.error(
        "Delete enquiry error:",
        error.message
      );

      res.status(500).json({
        success: false,
        message:
          "Failed to delete enquiry.",
      });
    }
  }
);

/* =========================
   LOGO
========================= */

app.post(
  "/api/admin/upload-logo",
  authenticateAdmin,
  upload.single("logo"),
  async (req, res) => {
    let localPath = null;

    try {
      if (!req.file) {
        return res.status(400).json({
          success: false,
          message:
            "Please select a logo image.",
        });
      }

      localPath =
        req.file.path;

      const ext =
        path.extname(
          req.file.originalname
        ).toLowerCase();

      const storagePath =
        `logo/logo-${Date.now()}${ext}`;

      const imageUrl =
        await uploadFileToSupabase(
          localPath,
          storagePath,
          req.file.mimetype
        );

      const oldResult =
        await pool.query(
          `
          SELECT image_url
          FROM site_images
          WHERE image_type = 'logo'
          LIMIT 1
          `
        );

      await pool.query(
        `
        INSERT INTO site_images
        (
          image_type,
          image_url,
          updated_at
        )
        VALUES
        (
          'logo',
          $1,
          CURRENT_TIMESTAMP
        )
        ON CONFLICT (image_type)
        DO UPDATE SET
          image_url = EXCLUDED.image_url,
          updated_at = CURRENT_TIMESTAMP
        `,
        [imageUrl]
      );

      if (
        oldResult.rows.length > 0 &&
        oldResult.rows[0].image_url
      ) {
        await deleteFromSupabase(
          oldResult.rows[0]
            .image_url
        );
      }

      if (
        localPath &&
        fs.existsSync(localPath)
      ) {
        fs.unlinkSync(
          localPath
        );
      }

      localPath = null;

      res.json({
        success: true,
        message:
          "Logo uploaded successfully.",
        image_url:
          imageUrl,
      });
    } catch (error) {
      console.error(
        "Logo upload error:",
        error.message
      );

      if (
        localPath &&
        fs.existsSync(localPath)
      ) {
        try {
          fs.unlinkSync(
            localPath
          );
        } catch {}
      }

      res.status(500).json({
        success: false,
        message:
          "Failed to upload logo.",
      });
    }
  }
);

app.get(
  "/api/admin/logo",
  async (req, res) => {
    try {
      const result =
        await pool.query(
          `
          SELECT image_url
          FROM site_images
          WHERE image_type = 'logo'
          LIMIT 1
          `
        );

      if (
        result.rows.length === 0
      ) {
        return res.json({
          success: true,
          logo: null,
        });
      }

      res.json({
        success: true,
        logo:
          result.rows[0]
            .image_url,
      });
    } catch (error) {
      console.error(
        "Logo fetch error:",
        error.message
      );

      res.status(500).json({
        success: false,
        message:
          "Failed to load logo.",
      });
    }
  }
);

/* =========================
   GALLERY
========================= */

app.get(
  "/api/gallery",
  async (req, res) => {
    try {
      const result =
        await pool.query(`
          SELECT
            id,
            title,
            category,
            image_url,
            created_at
          FROM gallery
          ORDER BY created_at DESC
        `);

      const gallery =
        result.rows.map(
          (item) => ({
            ...item,
            image_url:
              item.image_url,
          })
        );

      res.json({
        success: true,
        gallery,
      });
    } catch (error) {
      console.error(
        "Gallery fetch error:",
        error.message
      );

      res.status(500).json({
        success: false,
        message:
          "Failed to load gallery.",
      });
    }
  }
);

app.post(
  "/api/admin/gallery",
  authenticateAdmin,
  upload.single("image"),
  async (req, res) => {
    let localPath = null;
    let uploadedUrl = null;

    try {
      const {
        title,
        category,
      } = req.body;

      if (!req.file) {
        return res.status(400).json({
          success: false,
          message:
            "Please select an image.",
        });
      }

      if (
        !title ||
        !category
      ) {
        return res.status(400).json({
          success: false,
          message:
            "Title and category are required.",
        });
      }

      localPath =
        req.file.path;

      const ext =
        path.extname(
          req.file.originalname
        ).toLowerCase();

      const filename =
        `gallery-${Date.now()}-${Math.round(
          Math.random() * 1e9
        )}${ext}`;

      const storagePath =
        `gallery/${filename}`;

      uploadedUrl =
        await uploadFileToSupabase(
          localPath,
          storagePath,
          req.file.mimetype
        );

      const result =
        await pool.query(
          `
          INSERT INTO gallery
          (
            title,
            category,
            image_url
          )
          VALUES
          (
            $1,
            $2,
            $3
          )
          RETURNING *
          `,
          [
            title,
            category,
            uploadedUrl,
          ]
        );

      if (
        localPath &&
        fs.existsSync(localPath)
      ) {
        fs.unlinkSync(
          localPath
        );
      }

      localPath = null;

      res.status(201).json({
        success: true,
        message:
          "Gallery image uploaded successfully.",
        gallery:
          result.rows[0],
      });
    } catch (error) {
      console.error(
        "Gallery upload error:",
        error.message
      );

      if (uploadedUrl) {
        await deleteFromSupabase(
          uploadedUrl
        );
      }

      if (
        localPath &&
        fs.existsSync(localPath)
      ) {
        try {
          fs.unlinkSync(
            localPath
          );
        } catch {}
      }

      res.status(500).json({
        success: false,
        message:
          "Failed to upload gallery image.",
      });
    }
  }
);

app.delete(
  "/api/admin/gallery/:id",
  authenticateAdmin,
  async (req, res) => {
    try {
      const galleryId =
        req.params.id;

      const result =
        await pool.query(
          `
          DELETE FROM gallery
          WHERE id = $1
          RETURNING *
          `,
          [galleryId]
        );

      if (
        result.rows.length === 0
      ) {
        return res.status(404).json({
          success: false,
          message:
            "Gallery image not found.",
        });
      }

      const imageUrl =
        result.rows[0]
          .image_url;

      await deleteFromSupabase(
        imageUrl
      );

      res.json({
        success: true,
        message:
          "Gallery image deleted successfully.",
      });
    } catch (error) {
      console.error(
        "Gallery delete error:",
        error.message
      );

      res.status(500).json({
        success: false,
        message:
          "Failed to delete gallery image.",
      });
    }
  }
);

/* =========================
   WEBSITE IMAGES
   hero / feature / about
========================= */

const allowedSiteImageTypes = [
  "hero",
  "feature",
  "about",
];

app.get(
  "/api/site-images",
  async (req, res) => {
    try {
      const result =
        await pool.query(`
          SELECT
            image_type,
            image_url,
            updated_at
          FROM site_images
          WHERE image_type IN
          (
            'hero',
            'feature',
            'about'
          )
          ORDER BY id ASC
        `);

      const images = {};

      result.rows.forEach(
        (row) => {
          images[
            row.image_type
          ] = row.image_url;
        }
      );

      res.json({
        success: true,
        images,
      });
    } catch (error) {
      console.error(
        "Site images fetch error:",
        error.message
      );

      res.status(500).json({
        success: false,
        message:
          "Failed to load website images.",
      });
    }
  }
);

app.post(
  "/api/admin/site-images/:type",
  authenticateAdmin,
  upload.single("image"),
  async (req, res) => {
    let localPath = null;
    let uploadedUrl = null;

    try {
      const imageType =
        req.params.type;

      if (
        !allowedSiteImageTypes.includes(
          imageType
        )
      ) {
        return res.status(400).json({
          success: false,
          message:
            "Invalid website image type.",
        });
      }

      if (!req.file) {
        return res.status(400).json({
          success: false,
          message:
            "Please select an image.",
        });
      }

      localPath =
        req.file.path;

      const ext =
        path.extname(
          req.file.originalname
        ).toLowerCase();

      const filename =
        `site-${imageType}-${Date.now()}${ext}`;

      const storagePath =
        `site-images/${filename}`;

      uploadedUrl =
        await uploadFileToSupabase(
          localPath,
          storagePath,
          req.file.mimetype
        );

      const oldResult =
        await pool.query(
          `
          SELECT image_url
          FROM site_images
          WHERE image_type = $1
          LIMIT 1
          `,
          [imageType]
        );

      await pool.query(
        `
        INSERT INTO site_images
        (
          image_type,
          image_url,
          updated_at
        )
        VALUES
        (
          $1,
          $2,
          CURRENT_TIMESTAMP
        )
        ON CONFLICT (image_type)
        DO UPDATE SET
          image_url = EXCLUDED.image_url,
          updated_at = CURRENT_TIMESTAMP
        `,
        [
          imageType,
          uploadedUrl,
        ]
      );

      if (
        oldResult.rows.length > 0 &&
        oldResult.rows[0].image_url
      ) {
        await deleteFromSupabase(
          oldResult.rows[0]
            .image_url
        );
      }

      if (
        localPath &&
        fs.existsSync(localPath)
      ) {
        fs.unlinkSync(
          localPath
        );
      }

      localPath = null;

      res.json({
        success: true,
        message:
          `${imageType} image updated successfully.`,
        image_type:
          imageType,
        image_url:
          uploadedUrl,
      });
    } catch (error) {
      console.error(
        "Website image upload error:",
        error.message
      );

      if (uploadedUrl) {
        await deleteFromSupabase(
          uploadedUrl
        );
      }

      if (
        localPath &&
        fs.existsSync(localPath)
      ) {
        try {
          fs.unlinkSync(
            localPath
          );
        } catch {}
      }

      res.status(500).json({
        success: false,
        message:
          "Failed to update website image.",
      });
    }
  }
);

/* =========================
   ERROR HANDLER
========================= */

app.use(
  (
    error,
    req,
    res,
    next
  ) => {
    if (
      error instanceof
      multer.MulterError
    ) {
      if (
        error.code ===
        "LIMIT_FILE_SIZE"
      ) {
        return res.status(400).json({
          success: false,
          message:
            "Image size must be maximum 5 MB.",
        });
      }

      return res.status(400).json({
        success: false,
        message:
          error.message,
      });
    }

    if (error) {
      return res.status(400).json({
        success: false,
        message:
          error.message,
      });
    }

    next();
  }
);

app.listen(
  PORT,
  () => {
    console.log(
      `Server running on port ${PORT}`
    );

    if (PUBLIC_BASE_URL) {
      console.log(
        `Public URL: ${PUBLIC_BASE_URL}`
      );
    }

    console.log(
      "Supabase Storage: connected"
    );
    console.log(
      `Supabase bucket: ${SUPABASE_BUCKET}`
    );
  }
);






