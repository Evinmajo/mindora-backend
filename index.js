const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const Razorpay = require('razorpay');
const crypto = require('crypto');
require('dotenv').config();

const app = express();

// =====================================================
// 1. MIDDLEWARES & RAZORPAY WEBHOOK
// =====================================================

app.use(cors());

// Razorpay webhook MUST use raw body before express.json()
app.post(
  '/api/webhooks/razorpay',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    try {
      const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
      const signature = req.headers['x-razorpay-signature'];

      if (!webhookSecret) {
        console.error(
          '❌ RAZORPAY_WEBHOOK_SECRET is missing in environment variables.'
        );

        return res.status(500).json({
          success: false,
          error: 'Server webhook configuration error',
        });
      }

      if (!signature) {
        return res.status(400).json({
          success: false,
          error: 'Missing x-razorpay-signature header',
        });
      }

      const expectedSignature = crypto
        .createHmac('sha256', webhookSecret)
        .update(req.body)
        .digest('hex');

      if (expectedSignature !== signature) {
        console.warn('⚠️ Invalid Razorpay webhook signature');

        return res.status(400).json({
          success: false,
          error: 'Invalid webhook signature',
        });
      }

      const eventData = JSON.parse(req.body.toString());
      const event = eventData.event;

      if (event === 'payment.captured' || event === 'order.paid') {
        const payment = eventData.payload.payment.entity;

        const orderId = payment.order_id;
        const paymentId = payment.id;
        const bookingId = payment.notes?.bookingId;

        let booking = null;

        if (bookingId) {
          booking = await Booking.findById(bookingId);
        } else if (orderId) {
          booking = await Booking.findOne({ orderId });
        }

        if (booking) {
          const wasConfirmed = booking.status === 'Confirmed';

          booking.status = 'Confirmed';
          booking.paymentId = paymentId;
          booking.orderId = orderId;

          await booking.save();

          if (!wasConfirmed) {
            console.log(
              `✅ Webhook confirmed Booking ID: ${booking._id}`
            );

            sendConfirmationEmail(
              booking,
              paymentId
            ).catch((err) =>
              console.error('Webhook Email error:', err)
            );
          }
        }
      }

      res.status(200).json({
        status: 'ok',
      });
    } catch (error) {
      console.error(
        '❌ Webhook Processing Error:',
        error
      );

      res.status(500).json({
        success: false,
        error: error.message,
      });
    }
  }
);

// Normal JSON parser for other routes
app.use(express.json());

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

// =====================================================
// 4. BREVO API EMAIL CONFIGURATION
// =====================================================

// IMPORTANT:
// This uses HTTPS port 443.
// It does NOT use SMTP ports 25/465/587.
// Therefore it works with Render Free services.

if (!process.env.BREVO_API_KEY) {
  console.error(
    '❌ BREVO_API_KEY is missing in environment variables.'
  );
} else if (!process.env.EMAIL_FROM) {
  console.error(
    '❌ EMAIL_FROM is missing in environment variables.'
  );
} else {
  console.log(
    '✅ Brevo API email configuration is present'
  );
}

// =====================================================
// 5. BREVO EMAIL FUNCTION
// =====================================================

async function sendBrevoEmail({
  to,
  toName,
  subject,
  html,
}) {
  if (!process.env.BREVO_API_KEY) {
    throw new Error(
      'BREVO_API_KEY is missing in environment variables'
    );
  }

  if (!process.env.EMAIL_FROM) {
    throw new Error(
      'EMAIL_FROM is missing in environment variables'
    );
  }

  const response = await fetch(
    'https://api.brevo.com/v3/smtp/email',
    {
      method: 'POST',

      headers: {
        accept: 'application/json',
        'api-key': process.env.BREVO_API_KEY,
        'content-type': 'application/json',
      },

      body: JSON.stringify({
        sender: {
          name: 'Mindora Health',
          email: process.env.EMAIL_FROM,
        },

        to: [
          {
            email: to,
            ...(toName
              ? { name: toName }
              : {}),
          },
        ],

        subject,

        htmlContent: html,
      }),
    }
  );

  const responseText = await response.text();

  if (!response.ok) {
    throw new Error(
      `Brevo API ${response.status}: ${responseText}`
    );
  }

  let result = {};

  try {
    result = responseText
      ? JSON.parse(responseText)
      : {};
  } catch {
    result = {};
  }

  console.log(
    `📧 Brevo email sent successfully! Message ID: ${
      result.messageId || 'N/A'
    }`
  );

  return result;
}

// =====================================================
// 6. DATABASE CONNECTION
// =====================================================

const MONGO_URI =
  process.env.MONGO_URI ||
  'mongodb://localhost:27017/my_app';

mongoose
  .connect(MONGO_URI)
  .then(() =>
    console.log(
      '✅ MongoDB connected successfully'
    )
  )
  .catch((err) =>
    console.error(
      '❌ MongoDB connection error:',
      err
    )
  );

// =====================================================
// 7. BOOKING MODEL
// =====================================================

const bookingSchema = new mongoose.Schema({
  service: {
    type: String,
    required: true,
  },

  minutes: {
    type: Number,
    required: true,
  },

  price: {
    type: String,
    required: true,
  },

  date: {
    type: String,
    required: true,
  },

  time: {
    type: String,
    required: true,
  },

  name: {
    type: String,
    required: true,
  },

  email: {
    type: String,
    required: true,
  },

  phone: {
    type: String,
    default: '',
  },

  note: {
    type: String,
    default: '',
  },

  status: {
    type: String,

    enum: [
      'Pending Payment',
      'Pending',
      'Confirmed',
      'Cancelled',
    ],

    default: 'Pending Payment',
  },

  paymentId: {
    type: String,
    default: '',
  },

  orderId: {
    type: String,
    default: '',
  },

  meetLink: {
    type: String,
    default: '',
  },

  createdAt: {
    type: Date,
    default: Date.now,
  },
});

const Booking =
  mongoose.model('Booking', bookingSchema);

// =====================================================
// 8. CONFIRMATION EMAIL
// =====================================================

async function sendConfirmationEmail(
  booking,
  paymentId
) {
  const html = `
    <div style="
      font-family: Arial, sans-serif;
      max-width: 600px;
      margin: 0 auto;
      color: #1f2937;
      border: 1px solid #e5e7eb;
      border-radius: 12px;
      padding: 24px;
    ">

      <h2 style="
        color: #15803d;
        margin-top: 0;
      ">
        Payment Successful & Booking Confirmed!
      </h2>

      <p>
        Dear ${booking.name},
      </p>

      <p>
        Thank you for your payment.
        Your consultation session has been
        scheduled successfully.
      </p>

      <div style="
        background-color: #f9fafb;
        padding: 16px;
        border-radius: 8px;
        margin: 16px 0;
        font-size: 14px;
        line-height: 1.6;
      ">

        <p style="margin: 4px 0;">
          <strong>Service:</strong>
          ${booking.service}
        </p>

        <p style="margin: 4px 0;">
          <strong>Duration:</strong>
          ${booking.minutes} mins
          (${booking.price})
        </p>

        <p style="margin: 4px 0;">
          <strong>Date:</strong>
          ${booking.date}
        </p>

        <p style="margin: 4px 0;">
          <strong>Time:</strong>
          ${booking.time}
        </p>

        <p style="margin: 4px 0;">
          <strong>Payment ID:</strong>
          ${paymentId}
        </p>

      </div>

      <p>
        We will send your meeting link shortly
        before your scheduled session.
      </p>

      <hr style="
        border: 0;
        border-top: 1px solid #e5e7eb;
        margin: 24px 0;
      " />

      <p style="
        font-size: 12px;
        color: #6b7280;
        text-align: center;
      ">
        Mindora Health & Wellbeing
      </p>

    </div>
  `;

  return sendBrevoEmail({
    to: booking.email,
    toName: booking.name,

    subject:
      `Payment & Booking Confirmed — ${booking.service}`,

    html,
  });
}

// =====================================================
// 9. RAZORPAY ORDER CREATION WITH RETRY
// =====================================================

async function createRazorpayOrderWithRetry(
  options,
  retries = 2
) {
  for (
    let attempt = 1;
    attempt <= retries;
    attempt++
  ) {
    try {
      return await razorpay.orders.create(
        options
      );
    } catch (err) {
      console.warn(
        `⚠️ Razorpay order creation attempt ${attempt} failed: ${err.message}`
      );

      if (attempt === retries) {
        throw err;
      }

      await new Promise((resolve) =>
        setTimeout(resolve, 1000)
      );
    }
  }
}

// =====================================================
// 10. HEALTH CHECK
// =====================================================

app.get('/api/health', (req, res) => {
  res.json({
    status: 'OK',
    message: 'Server is running',
  });
});

// =====================================================
// 11. CREATE BOOKING
// =====================================================

app.post('/api/bookings', async (req, res) => {
  try {
    const newBooking =
      new Booking(req.body);

    await newBooking.save();

    res.status(201).json({
      success: true,
      booking: newBooking,
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error.message,
    });
  }
});

// =====================================================
// 12. CREATE RAZORPAY PAYMENT ORDER
// =====================================================

app.post(
  '/api/payments/create-order',
  async (req, res) => {
    try {
      const { bookingId } = req.body;

      if (!bookingId) {
        return res.status(400).json({
          success: false,
          error: 'Booking ID is required',
        });
      }

      const booking =
        await Booking.findById(bookingId);

      if (!booking) {
        return res.status(404).json({
          success: false,
          error: 'Booking not found',
        });
      }

      const numericAmount =
        parseInt(
          booking.price.replace(
            /[^0-9]/g,
            ''
          ),
          10
        ) || 350;

      const options = {
        amount:
          Math.round(
            numericAmount * 100
          ),

        currency: 'INR',

        receipt:
          `rcpt_${bookingId
            .toString()
            .slice(-8)}_${Date.now()}`,

        notes: {
          bookingId:
            bookingId.toString(),
        },
      };

      const order =
        await createRazorpayOrderWithRetry(
          options
        );

      booking.orderId = order.id;

      await booking.save();

      res.json({
        success: true,
        order,
      });
    } catch (error) {
      console.error(
        '❌ Razorpay Order Error:',
        error
      );

      res.status(503).json({
        success: false,

        error:
          'Razorpay server is currently busy or unreachable. Please try again in a few moments.',
      });
    }
  }
);

// =====================================================
// SITEMAP ROUTE
// =====================================================
app.get('/sitemap.xml', (req, res) => {
  res.header('Content-Type', 'application/xml');
  res.send(`<?xml version="1.0" encoding="UTF-8"?>
<?xml-stylesheet type="text/css" href="https://www.xml-sitemaps.com/css/sitemap.css"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">
  <url>
       <loc>https://www.mindorapsychologyconsultancy.com/</loc>
       <lastmod>2026-09-29T08:26:41+00:00</lastmod>
       <priority>1.0000</priority>
  </url>
  <url>
       <loc>https://www.mindorapsychologyconsultancy.com/about</loc>
       <lastmod>2026-09-29T08:26:41+00:00</lastmod>
       <priority>0.8000</priority>
  </url>
  <url>
       <loc>https://www.mindorapsychologyconsultancy.com/services</loc>
       <lastmod>2026-09-29T08:26:41+00:00</lastmod>
       <priority>0.8000</priority>
  </url>
  <url>
       <loc>https://www.mindorapsychologyconsultancy.com/resources</loc>
       <lastmod>2026-09-29T08:26:41+00:00</lastmod>
       <priority>0.8000</priority>
  </url>
  <url>
       <loc>https://www.mindorapsychologyconsultancy.com/contact</loc>
       <lastmod>2026-09-29T08:26:41+00:00</lastmod>
       <priority>0.8000</priority>
  </url>
  <url>
       <loc>https://www.mindorapsychologyconsultancy.com/book</loc>
       <lastmod>2026-09-29T08:26:41+00:00</lastmod>
       <priority>0.8000</priority>
  </url>
</urlset>`);
});

// =====================================================
// 13. VERIFY RAZORPAY PAYMENT
// =====================================================

app.post(
  '/api/payments/verify',
  async (req, res) => {
    try {
      const {
        razorpay_order_id,
        razorpay_payment_id,
        razorpay_signature,
        bookingId,
      } = req.body;

      const body =
        razorpay_order_id +
        '|' +
        razorpay_payment_id;

      const expectedSignature =
        crypto
          .createHmac(
            'sha256',
            process.env.RAZORPAY_KEY_SECRET
          )
          .update(body.toString())
          .digest('hex');

      if (
        expectedSignature ===
        razorpay_signature
      ) {
        const existingBooking =
          await Booking.findById(
            bookingId
          );

        if (!existingBooking) {
          return res.status(404).json({
            success: false,
            error: 'Booking not found',
          });
        }

        const isAlreadyConfirmed =
          existingBooking.status ===
          'Confirmed';

        existingBooking.status =
          'Confirmed';

        existingBooking.orderId =
          razorpay_order_id;

        existingBooking.paymentId =
          razorpay_payment_id;

        await existingBooking.save();

        if (!isAlreadyConfirmed) {
          sendConfirmationEmail(
            existingBooking,
            razorpay_payment_id
          ).catch((err) =>
            console.error(
              'Email error:',
              err
            )
          );
        }

        res.json({
          success: true,

          message:
            'Payment verified successfully',

          booking: existingBooking,
        });
      } else {
        res.status(400).json({
          success: false,
          error:
            'Invalid payment signature',
        });
      }
    } catch (error) {
      console.error(
        'Payment verification error:',
        error
      );

      res.status(500).json({
        success: false,
        error: error.message,
      });
    }
  }
);

// =====================================================
// 14. ADMIN - FETCH ALL BOOKINGS
// =====================================================

app.get(
  '/api/admin/bookings',
  async (req, res) => {
    try {
      const bookings =
        await Booking.find().sort({
          createdAt: -1,
        });

      res.json({
        success: true,
        data: bookings,
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error.message,
      });
    }
  }
);

app.patch('/api/admin/bookings/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { status, customNote, meetLink } = req.body;

    const adminMessage = typeof customNote === 'string' ? customNote.trim() : '';

    const updateData = { status };
    if (meetLink !== undefined) updateData.meetLink = meetLink;

    const updatedBooking = await Booking.findByIdAndUpdate(id, updateData, { returnDocument: 'after' });
    if (!updatedBooking) return res.status(404).json({ success: false, error: 'Booking not found' });

    res.json({ success: true, booking: updatedBooking });

    if (status === 'Confirmed' || status === 'Cancelled') {
      const isConfirmed = status === 'Confirmed';
      const subject = isConfirmed 
        ? `Booking Confirmed — ${updatedBooking.service}` 
        : `Booking Update — Request Cancelled`;

      const html = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; color: #1f2937; border: 1px solid #e5e7eb; border-radius: 12px; padding: 24px;">
          <h2 style="color: ${isConfirmed ? '#15803d' : '#b91c1c'}; margin-top: 0;">
            ${isConfirmed ? 'Your Appointment is Confirmed!' : 'Appointment Cancellation Notice'}
          </h2>
          <p>Dear ${updatedBooking.name},</p>
          <p>
            ${isConfirmed 
              ? 'Your consultation request has been officially <strong>confirmed</strong>. Here are your booking details:' 
              : 'We regret to inform you that your booking request could not be accepted.'}
          </p>
          
          <!-- ADMIN CUSTOM NOTE (Placed here so Gmail parser reads it as primary content) -->
          ${adminMessage ? `
            <div style="background-color: #fef3c7; border: 1px solid #fcd34d; padding: 14px; border-radius: 8px; font-size: 14px; color: #92400e; margin: 16px 0; white-space: pre-wrap;">
              <strong>Message from admin:</strong><br />${adminMessage}
            </div>
          ` : ''}

          <div style="background-color: #f9fafb; padding: 16px; border-radius: 8px; margin: 16px 0; font-size: 14px; line-height: 1.6;">
            <p style="margin: 4px 0;"><strong>Service:</strong> ${updatedBooking.service}</p>
            <p style="margin: 4px 0;"><strong>Duration:</strong> ${updatedBooking.minutes} mins (${updatedBooking.price})</p>
            <p style="margin: 4px 0;"><strong>Date:</strong> ${updatedBooking.date}</p>
            <p style="margin: 4px 0;"><strong>Time:</strong> ${updatedBooking.time}</p>
            ${updatedBooking.note ? `<p style="margin: 4px 0;"><strong>Booking Description:</strong> ${updatedBooking.note}</p>` : ''}
          </div>

          ${isConfirmed && meetLink ? `
            <div style="background-color: #ecfdf5; border: 1px solid #a7f3d0; padding: 18px; border-radius: 8px; margin: 16px 0; text-align: center;">
              <p style="margin: 0 0 10px 0; font-size: 14px; font-weight: bold; color: #065f46;">Google Meet Session Link</p>
              <a href="${meetLink}" target="_blank" style="display: inline-block; background-color: #059669; color: #ffffff; text-decoration: none; padding: 10px 22px; border-radius: 6px; font-weight: bold; font-size: 14px;">Join Meeting</a>
              <p style="margin: 10px 0 0 0; font-size: 12px; color: #047857;">Direct URL: <a href="${meetLink}" style="color: #047857;">${meetLink}</a></p>
            </div>
          ` : ''}

          <p style="margin-top: 20px;">
            ${isConfirmed 
              ? (meetLink ? 'Please join the meeting link above at your scheduled appointment time.' : 'We will send the online meeting link shortly prior to the session time.') 
              : 'If you wish to reschedule or have any questions, feel free to reply to this email.'}
          </p>
          <hr style="border: 0; border-top: 1px solid #e5e7eb; margin: 24px 0;" />
          <p style="font-size: 12px; color: #6b7280; text-align: center;">Mindora Health & Wellbeing</p>
        </div>`;

      sendBrevoEmail({ to: updatedBooking.email, toName: updatedBooking.name, subject, html })
        .catch((mailErr) => console.error('❌ Failed to send status update email:', mailErr));
    }
  } catch (error) {
    console.error('Error updating booking:', error);
    if (!res.headersSent) res.status(400).json({ success: false, error: error.message });
  }
});

// =====================================================
// 16. ADMIN - DELETE BOOKING
// =====================================================

app.delete(
  '/api/admin/bookings/:id',
  async (req, res) => {
    try {
      const { id } = req.params;

      await Booking.findByIdAndDelete(id);

      res.json({
        success: true,
        message:
          'Booking deleted successfully',
      });
    } catch (error) {
      res.status(400).json({
        success: false,
        error: error.message,
      });
    }
  }
);

// =====================================================
// 17. START SERVER
// =====================================================

const PORT =
  process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(
    `🚀 Server listening on port ${PORT}`
  );
});
