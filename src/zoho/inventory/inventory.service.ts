import { Injectable } from '@nestjs/common';
import { ZohoHttpService } from '../core/zoho-http.service';
import { ConfigService } from '@nestjs/config';
import { ZohoAuthService } from '../core/zoho-auth.service';

type ZohoAddressPayload = {
  attention?: string;
  address: string;
  city: string;
  state: string;
  zip: string;
  phone?: string;
};

export function getZohoStateCode(inputState?: string): string {
  if (!inputState) return '';

  const state = inputState.trim().toLowerCase();

  const stateMap: Record<string, string> = {
    // States
    'andhra pradesh': 'AP',
    'arunachal pradesh': 'AR',
    'assam': 'AS',
    'bihar': 'BR',
    'chhattisgarh': 'CG',
    'goa': 'GA',
    'gujarat': 'GJ',
    'haryana': 'HR',
    'himachal pradesh': 'HP',
    'jharkhand': 'JH',
    'karnataka': 'KA',
    'kerala': 'KL',
    'madhya pradesh': 'MP',
    'maharashtra': 'MH',
    'manipur': 'MN',
    'meghalaya': 'ML',
    'mizoram': 'MZ',
    'nagaland': 'NL',
    'odisha': 'OR',
    'punjab': 'PB',
    'rajasthan': 'RJ',
    'sikkim': 'SK',
    'tamil nadu': 'TN',
    'telangana': 'TS',
    'tripura': 'TR',
    'uttar pradesh': 'UP',
    'uttarakhand': 'UA',
    'west bengal': 'WB',

    // Union Territories
    'andaman and nicobar islands': 'AN',
    'chandigarh': 'CH',
    'dadra and nagar haveli and daman and diu': 'DN',
    'delhi': 'DL',
    'jammu and kashmir': 'JK',
    'ladakh': 'LA',
    'lakshadweep': 'LD',
    'puducherry': 'PY',
  };

  return stateMap[state] ?? (inputState.length === 2 ? inputState.toUpperCase() : inputState);
}

@Injectable()
export class ZohoInventoryService {
  constructor(
    private http: ZohoHttpService,
    private config: ConfigService,
    private zohoAuthService: ZohoAuthService,
  ) { }

  private getOrgId() {
    return this.config.get<string>('ZOHO_ORG_ID') || '';
  }

  private limitAddress(value: any) {
    const normalized = String(value || '').replace(/\s+/g, ' ').trim();
    return normalized.length > 99 ? normalized.slice(0, 99) : normalized;
  }

  private inventoryUrl(path: string) {
    const separator = path.includes('?') ? '&' : '?';
    return `https://www.zohoapis.in/inventory/v1${path}${separator}organization_id=${this.getOrgId()}`;
  }

  private buildZohoAddress(order: any): ZohoAddressPayload {
    const address = order.address ?? {};
    const line1 = address.billingAddress ?? address.addressLine ?? address.line1 ?? address.address;
    const line2 = address.line2;
    const rawStreet = line2 ? `${line1}, ${line2}` : line1;
    const fullStreetAddress = this.limitAddress(rawStreet);
    const phone =
      order.customerMobile ?? address.phone ?? address.receiver_phone;

    if (!line1 || !address.city || !address.state || !address.pincode) {
      throw new Error('Order address is incomplete for Zoho sync');
    }

    const stateCode = getZohoStateCode(address.state);

    const zohoAddress: ZohoAddressPayload = {
      attention:
        order.customerName ||
        address.receiver_name ||
        address.name ||
        undefined,
      address: fullStreetAddress,
      city: address.city,
      state: stateCode || address.state,
      zip: address.pincode,
    };

    if (phone) {
      zohoAddress.phone = phone;
    }

    return zohoAddress;
  }

  private addressMatchesZoho(
    address: any,
    expected: ZohoAddressPayload,
  ): boolean {
    return (
      String(address?.address ?? '').trim() === expected.address.trim() &&
      String(address?.city ?? '').trim() === expected.city.trim() &&
      String(address?.state ?? '').trim() === expected.state.trim() &&
      String(address?.zip ?? '').trim() === expected.zip.trim()
    );
  }

  private async upsertContactAddresses(
    customerId: string,
    order: any,
  ): Promise<{
    billingAddressId: string;
    shippingAddressId: string;
  }> {
    const address = this.buildZohoAddress(order);
    const contactName =
      order.customerName || address.attention || 'App Customer';

    const updateRes = await this.http.request(
      'PUT',
      this.inventoryUrl(`/contacts/${customerId}`),
      'inventory',
      {
        contact_name: contactName,
        billing_address: address,
        shipping_address: address,
      },
    );

    const contact = updateRes?.contact ?? {};
    let billingAddressId =
      contact.billing_address?.address_id ?? contact.billing_address_id;
    let shippingAddressId =
      contact.shipping_address?.address_id ?? contact.shipping_address_id;

    if (!billingAddressId || !shippingAddressId) {
      const addressRes = await this.http.request(
        'GET',
        this.inventoryUrl(`/contacts/${customerId}/address`),
        'inventory',
      );

      const matchedAddress = (addressRes?.addresses ?? []).find((item: any) =>
        this.addressMatchesZoho(item, address),
      );

      billingAddressId = billingAddressId ?? matchedAddress?.address_id;
      shippingAddressId = shippingAddressId ?? matchedAddress?.address_id;
    }

    if (!billingAddressId || !shippingAddressId) {
      throw new Error('Failed to resolve Zoho contact address IDs');
    }

    return {
      billingAddressId: String(billingAddressId),
      shippingAddressId: String(shippingAddressId),
    };
  }

  // Simple in-memory cache: name.toLowerCase() → zoho salesperson_id
  private salespersonCache: Record<string, string> = {};

  async findSalespersonId(name: string): Promise<string | null> {
    // 1. Direct env override — set ZOHO_SALESPERSON_ID in .env to bypass API lookup
    const envId = this.config.get<string>('ZOHO_SALESPERSON_ID');
    if (envId) {
      console.log('[ZohoInventory] Using ZOHO_SALESPERSON_ID from env:', envId);
      return envId;
    }

    if (!name) return null;
    const key = name.toLowerCase().trim();
    if (this.salespersonCache[key]) return this.salespersonCache[key];

    // 2. Try /users endpoint (Zoho Inventory users serve as salespersons)
    try {
      const usersRes = await this.http.request(
        'GET',
        this.inventoryUrl('/users'),
        'inventory',
      );
      const users: any[] = usersRes?.users || [];
      console.log('[ZohoInventory] Users from Zoho (/users):', users.map((u: any) => ({
        user_id: u.user_id,
        name: u.name,
        role: u.role,
        email: u.email,
      })));
      for (const u of users) {
        if (u.user_id && u.name) {
          this.salespersonCache[(u.name || '').toLowerCase().trim()] = u.user_id;
        }
      }
      if (this.salespersonCache[key]) {
        console.log('[ZohoInventory] ✅ Found salesperson via /users:', this.salespersonCache[key]);
        return this.salespersonCache[key];
      }
    } catch (err: any) {
      console.warn('[ZohoInventory] Could not fetch /users:', err?.message);
    }

    // 3. Fall back to /salespersons
    try {
      const spRes = await this.http.request(
        'GET',
        this.inventoryUrl('/salespersons'),
        'inventory',
      );
      const list: any[] = spRes?.data || spRes?.salespersons || [];
      console.log('[ZohoInventory] Salespersons from /salespersons:', list.map((s: any) => ({
        id: s.salesperson_id,
        name: s.salesperson_name || s.name,
      })));
      for (const sp of list) {
        const spName = sp.salesperson_name || sp.name;
        if (sp.salesperson_id && spName) {
          this.salespersonCache[(spName || '').toLowerCase().trim()] = sp.salesperson_id;
        }
      }
      return this.salespersonCache[key] || null;
    } catch (err: any) {
      console.warn('[ZohoInventory] Could not fetch /salespersons:', err?.message);
      return null;
    }
  }

  async getItems(page = 1, perPage = 200): Promise<any> {
    return this.http.request(
      'GET',
      this.inventoryUrl(`/items?page=${page}&per_page=${perPage}`),
      'inventory',
    );
  }

  async getItem(itemId: string): Promise<any> {
    const response = await this.http.request(
      'GET',
      this.inventoryUrl(`/items/${itemId}`),
      'inventory',
    );

    return response?.item || null;
  }

  async downloadItemImage(itemId: string): Promise<Buffer> {
    return this.http.request(
      'GET',
      this.inventoryUrl(`/items/${itemId}/image`),
      'inventory',
      undefined,
      { responseType: 'arraybuffer' },
    );
  }

  async getItemImageUploadPayload(itemId: string, existingHash?: string) {
    const imageUrl = this.inventoryUrl(`/items/${itemId}/image`);
    const token = await this.zohoAuthService.getValidAccessToken('inventory');
    try {
      await this.http.request('GET', imageUrl, 'inventory', undefined, {
        responseType: 'stream',
      });
    } catch (err: any) {
      if (err?.response?.status === 400 || err?.response?.status === 404) {
        throw new Error(`NO_IMAGE: Item ${itemId} has no image in Zoho`);
      }
      throw err;
    }

    return { imageUrl, itemId, zohoToken: token, existingHash };
  }

  async createSalesOrder(order: any, customerId: string, salespersonId?: string): Promise<string> {
    const missingZohoItems = (order.items || []).filter(
      (item: any) => !item.zohoItemId,
    );

    if (missingZohoItems.length > 0) {
      throw new Error(
        `Missing Zoho item id for: ${missingZohoItems
          .map((item: any) => item.name || item.productId || 'Unknown item')
          .join(', ')}`,
      );
    }

    const { billingAddressId, shippingAddressId } =
      await this.upsertContactAddresses(customerId, order);

    const placeOfSupply = getZohoStateCode(order.address?.state);

    const payload: any = {
      customer_id: customerId,
      reference_number: order.orderId,
      is_inclusive_tax: true,
      ...(placeOfSupply ? { place_of_supply: placeOfSupply } : {}),
      line_items: order.items.map((item: any) => ({
        item_id: item.zohoItemId,
        name: item.name,
        rate: item.price,
        quantity: item.quantity,
      })),
      shipping_charge: order.shippingCharge,
      billing_address_id: billingAddressId,
      shipping_address_id: shippingAddressId,
    };

    if (salespersonId) {
      payload.salesperson_id = salespersonId;
      console.log('[ZohoInventory] Using salesperson_id:', salespersonId);
    } else {
      console.warn('[ZohoInventory] ⚠️ No salesperson_id — Zoho may reject if salespersons are required');
    }

    const response = await this.http.request(
      'POST',
      this.inventoryUrl('/salesorders'),
      'inventory',
      payload,
    );

    console.log('[ZohoInventory] ✅ Sales order created:', response.salesorder?.salesorder_id);

    return response.salesorder?.salesorder_id;
  }

  async getSalesOrder(salesOrderId: string): Promise<any> {
    const response = await this.http.request(
      'GET',
      this.inventoryUrl(`/salesorders/${salesOrderId}`),
      'inventory',
    );

    return response?.salesorder || null;
  }

  async findInvoiceByNumber(invoiceNumber: string): Promise<any> {
    if (!invoiceNumber) return null;

    const response = await this.http.request(
      'GET',
      this.inventoryUrl(`/invoices?invoice_number=${encodeURIComponent(invoiceNumber)}`),
      'inventory',
    );

    return response?.invoices?.find(
      (invoice: any) => invoice.invoice_number === invoiceNumber,
    ) || null;
  }

  async createInvoiceForPaidOrder(
    order: any,
    customerId: string,
    salesOrderId?: string,
  ): Promise<any> {
    const invoiceNumber = order.invoiceNumber || order.orderId;
    const existingInvoice = await this.findInvoiceByNumber(invoiceNumber);
    if (existingInvoice?.invoice_id) return existingInvoice;

    const salesOrder = salesOrderId ? await this.getSalesOrder(salesOrderId) : null;
    const salesOrderLineItems = Array.isArray(salesOrder?.line_items)
      ? salesOrder.line_items
      : [];

    const payload = {
      customer_id: customerId,
      invoice_number: invoiceNumber,
      reference_number: order.orderId,
      date: order.paymentDate || new Date().toISOString().split('T')[0],
      line_items: order.items.map((item: any) => {
        const salesOrderLineItem = salesOrderLineItems.find(
          (lineItem: any) => String(lineItem.item_id) === String(item.zohoItemId),
        );

        return {
          item_id: item.zohoItemId,
          salesorder_item_id: salesOrderLineItem?.line_item_id,
          name: item.name,
          rate: item.price,
          quantity: item.quantity,
        };
      }),
      shipping_charge: order.shippingCharge || 0,
      // Note: billing_address/shipping_address omitted — Zoho uses the contact's stored address.
      // Sending it causes "billing_address > 100 chars" errors from Zoho due to JSON serialization checks.
    };

    const response = await this.http.request(
      'POST',
      this.inventoryUrl('/invoices?ignore_auto_number_generation=true'),
      'inventory',
      payload,
    );

    return response?.invoice || null;
  }

  async recordCustomerPaymentForInvoice(params: {
    customerId: string;
    invoiceId: string;
    amount: number;
    paymentId?: string;
    paymentDate?: string;
  }): Promise<any> {
    const referenceNumber = params.paymentId || params.invoiceId;

    const existingPayments = await this.http.request(
      'GET',
      this.inventoryUrl(`/customerpayments?reference_number=${encodeURIComponent(referenceNumber)}`),
      'inventory',
    );

    const existingPayment = existingPayments?.customerpayments?.find(
      (payment: any) => payment.reference_number === referenceNumber,
    );
    if (existingPayment?.payment_id) return existingPayment;

    const payload = {
      customer_id: params.customerId,
      payment_mode: 'others',
      amount: Number(params.amount || 0),
      date: params.paymentDate || new Date().toISOString().split('T')[0],
      reference_number: referenceNumber,
      description: 'Paid online through Zoho Payments',
      invoices: [
        {
          invoice_id: params.invoiceId,
          amount_applied: Number(params.amount || 0),
        },
      ],
    };

    const response = await this.http.request(
      'POST',
      this.inventoryUrl('/customerpayments'),
      'inventory',
      payload,
    );

    return response?.payment || null;
  }

  async findOrCreateSalesCustomer(customer: any) {
    const searchText = encodeURIComponent(
      customer.customerPhone || customer.mobile || customer.customerName,
    );

    if (searchText) {
      const search = await this.http.request(
        'GET',
        this.inventoryUrl(`/contacts?search_text=${searchText}`),
        'inventory',
      );

      const existing = search?.contacts?.find((contact: any) => {
        const phone = String(customer.customerPhone || customer.mobile || '');
        return (
          contact.contact_id &&
          (contact.phone === phone ||
            contact.mobile === phone ||
            contact.contact_name === customer.customerName)
        );
      });

      if (existing?.contact_id) return existing.contact_id;
    }

    const payload = {
      contact_name: customer.customerName || 'Sales Portal Customer',
      contact_type: 'customer',
      phone: customer.customerPhone || customer.mobile || '',
      mobile: customer.customerPhone || customer.mobile || '',
      billing_address: {
        address: this.limitAddress(
          customer.billingAddress ||
            [customer.village, customer.district].filter(Boolean).join(', '),
        ),
        city: customer.district || '',
        state: customer.state || '',
        zip: customer.pin || '',
        phone: customer.customerPhone || customer.mobile || '',
      },
      shipping_address: {
        address: this.limitAddress(
          customer.billingAddress ||
            [customer.village, customer.district].filter(Boolean).join(', '),
        ),
        city: customer.district || '',
        state: customer.state || '',
        zip: customer.pin || '',
        phone: customer.customerPhone || customer.mobile || '',
      },
    };

    const response = await this.http.request(
      'POST',
      this.inventoryUrl('/contacts'),
      'inventory',
      payload,
    );

    return response.contact?.contact_id;
  }

  async markInvoiceAsSent(invoiceId: string): Promise<any> {
    const response = await this.http.request(
      'POST',
      this.inventoryUrl(`/invoices/${invoiceId}/status/sent`),
      'inventory',
    );

    return response?.invoice || null;
  }

  /**
   * Find an existing Zoho Inventory contact by phone number, or create a new one.
   * Used by the regular (non-salesperson) orders pipeline.
   * Returns the contact_id string.
   */
  async createOrGetContact(user: {
    name?: string;
    mobile_number: string;
    email?: string;
  }): Promise<string> {
    const orgId = this.getOrgId();

    // 1. Search for existing contact by phone
    try {
      const searchRes = await this.http.request(
        'GET',
        this.inventoryUrl(`/contacts?phone=${encodeURIComponent(user.mobile_number)}`),
        'inventory',
      );

      const contacts = searchRes?.contacts ?? [];
      const match = contacts.find(
        (c: any) =>
          c.phone === user.mobile_number || c.mobile === user.mobile_number,
      );

      if (match?.contact_id) {
        console.log(`[Zoho] Found existing contact: ${match.contact_id} for ${user.mobile_number}`);
        return match.contact_id;
      }
    } catch (err: any) {
      console.warn(`[Zoho] Contact search failed: ${err.message}, will create new`);
    }

    // 2. Create new contact
    const contactName = user.name || 'App Customer';
    const payload: any = {
      contact_name: contactName,
      contact_type: 'customer',
      phone: user.mobile_number,
      mobile: user.mobile_number,
    };

    if (user.email) {
      payload.email = user.email;
    }

    const createRes = await this.http.request(
      'POST',
      this.inventoryUrl('/contacts'),
      'inventory',
      payload,
    );

    const contactId = createRes?.contact?.contact_id;
    if (!contactId) {
      throw new Error(
        'Failed to create Zoho Inventory contact — no contact_id returned',
      );
    }

    console.log(`[Zoho] Created new contact: ${contactId} for ${user.mobile_number}`);
    return contactId;
  }

  /**
   * Create an invoice from an existing sales order.
   * Zoho will auto-populate line items from the SO.
   */
  async createInvoiceFromSalesOrder(
    salesorderId: string,
    customerId: string,
  ): Promise<{ invoiceId: string; invoiceNumber: string }> {
    const response = await this.http.request(
      'POST',
      this.inventoryUrl(`/invoices/fromsalesorder?salesorder_id=${salesorderId}`),
      'inventory',
    );

    const invoice = response?.invoice;
    if (!invoice?.invoice_id) {
      throw new Error('Failed to create invoice — no invoice_id returned');
    }

    console.log(
      `[Zoho] Invoice created: ${invoice.invoice_number} (${invoice.invoice_id}) from SO ${salesorderId}`,
    );

    return {
      invoiceId: invoice.invoice_id,
      invoiceNumber: invoice.invoice_number,
    };
  }

  /**
   * Record a customer payment against an invoice to mark it as Paid.
   */
  async recordPaymentForInvoice(
    customerId: string,
    invoiceId: string,
    amount: number,
    paymentReference: string,
  ): Promise<string> {
    const payload = {
      customer_id: customerId,
      payment_mode: 'Online Payment',
      amount,
      date: new Date().toISOString().split('T')[0], // YYYY-MM-DD
      reference_number: paymentReference,
      invoices: [
        {
          invoice_id: invoiceId,
          amount_applied: amount,
        },
      ],
    };

    const response = await this.http.request(
      'POST',
      this.inventoryUrl('/customerpayments'),
      'inventory',
      payload,
    );

    const paymentId = response?.payment?.payment_id;
    console.log(
      `[Zoho] Payment recorded: ${paymentId} for invoice ${invoiceId} (₹${amount})`,
    );

    return paymentId;
  }

  /**
   * Full flow: Create Sales Order → Invoice → Record Payment.
   * Returns all IDs for tracking.
   */
  async createSalesOrderWithInvoice(
    order: any,
    customerId: string,
    salespersonId?: string,
  ): Promise<{
    salesOrderId: string;
    invoiceId: string;
    invoiceNumber: string;
    paymentId: string;
  }> {
    // 1. Create Sales Order
    const salesOrderId = await this.createSalesOrder(order, customerId, salespersonId);
    console.log(`[Zoho] Step 1/3: Sales Order created: ${salesOrderId}`);

    // 2. Create Invoice from Sales Order
    const { invoiceId, invoiceNumber } = await this.createInvoiceFromSalesOrder(
      salesOrderId,
      customerId,
    );
    console.log(`[Zoho] Step 2/3: Invoice created: ${invoiceNumber}`);

    // 3. Record Payment to clear the invoice
    const paymentId = await this.recordPaymentForInvoice(
      customerId,
      invoiceId,
      order.finalAmount,
      order.orderId, // Use app order ID as payment reference
    );
    console.log(`[Zoho] Step 3/3: Payment recorded: ${paymentId}`);

    return { salesOrderId, invoiceId, invoiceNumber, paymentId };
  }
}
