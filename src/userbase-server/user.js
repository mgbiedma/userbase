import uuidv4 from 'uuid/v4'
import connection from './connection'
import setup from './setup'
import statusCodes from './statusCodes'
import responseBuilder from './responseBuilder'
import crypto from './crypto'
import logger from './logger'
import { validateEmail, trimReq, truncateSessionId, getTtl } from './utils'
import appController from './app'
import adminController from './admin'
import stripe from './stripe'

// source: https://github.com/OWASP/CheatSheetSeries/blob/master/cheatsheets/Session_Management_Cheat_Sheet.md#session-id-length
const ACCEPTABLE_RANDOM_BYTES_FOR_SAFE_SESSION_ID = 16
const AUTH_TOKEN_STRING_LENGTH = 32

const VALIDATION_MESSAGE_LENGTH = 16
const UUID_STRING_LENGTH = 36

const HOURS_IN_A_DAY = 24
const SECONDS_IN_A_DAY = 60 * 60 * HOURS_IN_A_DAY
const MS_IN_A_DAY = 1000 * SECONDS_IN_A_DAY
const SESSION_LENGTH = MS_IN_A_DAY

const MAX_USERNAME_CHAR_LENGTH = 100

const MAX_PROFILE_OBJECT_KEY_CHAR_LENGTH = 20
const MAX_PROFILE_OBJECT_VALUE_CHAR_LENGTH = 1000
const MAX_PROFILE_OBJECT_KEYS = 100

const LIMIT_NUM_TRIAL_USERS = 3

const MAX_INCORRECT_PASSWORD_GUESSES = 25

const createSession = async function (userId, appId) {
  // sessionId is used to authenticate that a user is signed in. The sessionId allows
  // the user to sign in without their password and open a WebSocket connection to the server
  const sessionId = crypto
    .randomBytes(ACCEPTABLE_RANDOM_BYTES_FOR_SAFE_SESSION_ID)
    .toString('hex')

  // authToken is used to verify the user is signed in to an existing session.
  // It has no other privileges, unlike the session ID
  const authToken = crypto
    .randomBytes(ACCEPTABLE_RANDOM_BYTES_FOR_SAFE_SESSION_ID)
    .toString('hex')

  const creationDate = new Date().toISOString()
  const session = {
    'session-id': sessionId,
    'auth-token': authToken,
    'user-id': userId,
    'app-id': appId,
    'creation-date': creationDate,
    ttl: getTtl(SECONDS_IN_A_DAY),
  }

  const params = {
    TableName: setup.sessionsTableName,
    Item: session
  }

  const ddbClient = connection.ddbClient()
  await ddbClient.put(params).promise()

  return { sessionId, authToken, creationDate }
}

const _buildSignUpParams = (username, passwordToken, appId, userId,
  publicKey, passwordSalts, keySalts, email, profile, passwordBasedBackup) => {

  const {
    passwordSalt,
    passwordTokenSalt
  } = passwordSalts

  const {
    encryptionKeySalt,
    dhKeySalt,
    hmacKeySalt
  } = keySalts

  const { passwordBasedEncryptionKeySalt, passwordEncryptedSeed } = passwordBasedBackup

  const user = {
    username: username.toLowerCase(),
    'password-token': crypto.sha256.hash(passwordToken),
    'password-salt': passwordSalt,
    'password-token-salt': passwordTokenSalt,
    'app-id': appId,
    'user-id': userId,
    'public-key': publicKey,
    'encryption-key-salt': encryptionKeySalt,
    'diffie-hellman-key-salt': dhKeySalt,
    'hmac-key-salt': hmacKeySalt,
    'seed-not-saved-yet': true,
    'creation-date': new Date().toISOString(),
    'password-based-encryption-key-salt': passwordBasedEncryptionKeySalt,
    'password-encrypted-seed': passwordEncryptedSeed
  }

  if (email) user.email = email.toLowerCase()
  if (profile) user.profile = profile

  return {
    TableName: setup.usersTableName,
    Item: user,
    // if username does not exist, insert
    // if it already exists and user hasn't saved seed yet, overwrite (to allow another sign up attempt)
    // if it already exists and user has saved seed, fail with ConditionalCheckFailedException
    ConditionExpression: 'attribute_not_exists(username) or attribute_exists(#seedNotSavedYet)',
    ExpressionAttributeNames: {
      '#seedNotSavedYet': 'seed-not-saved-yet'
    }
  }
}

const _allowUserToRetryPassword = (user) => {
  const params = {
    TableName: setup.usersTableName,
    Key: {
      'username': user['username'],
      'app-id': user['app-id']
    },
    UpdateExpression: 'REMOVE #suspendedAt SET #incorrectAttempts = :incorrectAttempts',
    ExpressionAttributeNames: {
      '#suspendedAt': 'suspended-at',
      '#incorrectAttempts': 'incorrect-password-attempts-in-a-row'
    },
    ExpressionAttributeValues: {
      ':incorrectAttempts': 0
    }
  }

  const ddbClient = connection.ddbClient()
  ddbClient.update(params).promise()
}

const _suspendUser = (user) => {
  const params = {
    TableName: setup.usersTableName,
    Key: {
      'username': user['username'],
      'app-id': user['app-id']
    },
    UpdateExpression: 'SET #suspendedAt = :suspendedAt',
    ExpressionAttributeNames: {
      '#suspendedAt': 'suspended-at'
    },
    ExpressionAttributeValues: {
      ':suspendedAt': new Date().toISOString()
    }
  }

  const ddbClient = connection.ddbClient()
  ddbClient.update(params).promise()
}

const _incrementIncorrectPasswordAttempt = (user) => {
  const incrementParams = {
    TableName: setup.usersTableName,
    Key: {
      'username': user['username'],
      'app-id': user['app-id']
    },
    UpdateExpression: 'add #incorrectAttempts :num',
    ExpressionAttributeNames: {
      '#incorrectAttempts': 'incorrect-password-attempts-in-a-row'
    },
    ExpressionAttributeValues: {
      ':num': 1
    }
  }

  const ddbClient = connection.ddbClient()
  ddbClient.update(incrementParams).promise()
}

const _validatePassword = (passwordToken, user, req) => {
  if (!user) throw new Error('User does not exist')

  if (user['incorrect-password-attempts-in-a-row'] >= MAX_INCORRECT_PASSWORD_GUESSES) {

    const dateSuspended = user['suspended-at']
    if (!dateSuspended) {
      _suspendUser(user)

      logger
        .child({ userId: user['user-id'], req: trimReq(req) })
        .warn('Someone has exceeded the password attempt limit')
    }

    if (!dateSuspended || new Date() - new Date(dateSuspended) < MS_IN_A_DAY) {
      throw {
        error: 'PasswordAttemptLimitExceeded',
        delay: '24 hours'
      }
    } else {
      _allowUserToRetryPassword(user)
    }
  }

  const passwordTokenHash = crypto.sha256.hash(passwordToken)
  const passwordIsCorrect = passwordTokenHash.equals(user['password-token'])

  if (passwordIsCorrect) {
    _allowUserToRetryPassword(user)
  } else {
    const tempPasswordIsCorrect = user['temp-password-token'] && passwordTokenHash.equals(user['temp-password-token'])

    if (!tempPasswordIsCorrect) {
      _incrementIncorrectPasswordAttempt(user)
      throw { error: 'Incorrect password or temp password' }
    } else if (new Date() - new Date(user['temp-password-creation-date']) > MS_IN_A_DAY) {
      _incrementIncorrectPasswordAttempt(user)
      throw { error: 'Temp password expired' }
    }

    // returns true if temp password is used
    return tempPasswordIsCorrect
  }

  return false
}

const _validateProfile = (profile) => {
  if (typeof profile !== 'object') throw { error: 'ProfileMustBeObject', message: 'Profile must be a flat JSON object.' }

  let counter = 0
  for (const key in profile) {
    if (key.length > MAX_PROFILE_OBJECT_KEY_CHAR_LENGTH) {
      const maxLen = MAX_PROFILE_OBJECT_KEY_CHAR_LENGTH
      throw { error: 'ProfileKeyTooLong', message: `Profile key too long. Must be a max of ${maxLen} characters.`, key, maxLen }
    }

    const value = profile[key]
    if (typeof value !== 'string') {
      throw { error: 'ProfileValueMustBeString', message: 'Profile value must be a string.', key, value }
    }

    // no empty string in DDB: https://forums.aws.amazon.com/thread.jspa?threadID=90137&start=50&tstart=0
    if (!value.length) {
      throw { error: 'ProfileValueCannotBeBlank', message: 'Profile value cannot be blank.', key }
    }

    if (value.length > MAX_PROFILE_OBJECT_VALUE_CHAR_LENGTH) {
      const maxLen = MAX_PROFILE_OBJECT_VALUE_CHAR_LENGTH
      throw { error: 'ProfileValueTooLong', message: `Profile value too long. Must be a max of ${maxLen} characters.`, key, value, maxLen }
    }

    counter += 1
    if (counter > MAX_PROFILE_OBJECT_KEYS) {
      const maxKeys = MAX_PROFILE_OBJECT_KEYS
      throw { error: 'ProfileHasTooManyKeys', message: `Profile has too many keys. Must have a max of ${maxKeys} keys.`, maxKeys }
    }
  }

  if (!counter) throw { error: 'ProfileCannotBeEmpty', message: 'Profile cannot be empty.' }
}

const _validateUsernameInput = (username) => {
  if (typeof username !== 'string') throw {
    error: 'UsernameMustBeString'
  }

  if (!username) throw {
    error: 'UsernameCannotBeBlank'
  }

  if (username.length > MAX_USERNAME_CHAR_LENGTH) throw {
    error: 'UsernameTooLong',
    maxLen: MAX_USERNAME_CHAR_LENGTH
  }
}
exports._validateUsernameInput = _validateUsernameInput

const _validateSignUpInput = (appId, username, passwordToken, publicKey, passwordSalts, keySalts, passwordBasedBackup, email, profile) => {
  try {
    if (!appId || !username || !passwordToken || !publicKey || !passwordSalts || !keySalts || !passwordBasedBackup) {
      throw 'Missing required items'
    }

    const {
      passwordSalt,
      passwordTokenSalt
    } = passwordSalts

    const {
      encryptionKeySalt,
      dhKeySalt,
      hmacKeySalt
    } = keySalts

    if (!passwordSalt || !passwordTokenSalt || !encryptionKeySalt || !dhKeySalt || !hmacKeySalt) {
      throw 'Missing required salts'
    }

    const { passwordBasedEncryptionKeySalt, passwordEncryptedSeed } = passwordBasedBackup

    if (!passwordBasedEncryptionKeySalt || !passwordEncryptedSeed) {
      throw 'Missing password-based backup items'
    }

    _validateUsernameInput(username)

    if (email && !validateEmail(email)) {
      throw {
        error: 'EmailNotValid',
        email
      }
    }

    if (profile) _validateProfile(profile)
  } catch (e) {
    throw {
      status: statusCodes['Bad Request'],
      error: {
        message: e
      }
    }
  }
}

const _validateSubscription = async (status, cancelAt, appId) => {
  const unpaidSubscription = status !== 'active' || cancelAt
  if (unpaidSubscription) {
    const numUsers = await appController.countNonDeletedAppUsers(appId, LIMIT_NUM_TRIAL_USERS)
    if (numUsers >= LIMIT_NUM_TRIAL_USERS) {
      throw {
        status: statusCodes['Payment Required'],
        error: {
          message: 'TrialExceededLimit',
        }
      }
    }
  }
}

exports.signUp = async function (req, res) {
  const appId = req.query.appId

  const username = req.body.username
  const passwordToken = req.body.passwordToken

  const publicKey = req.body.publicKey

  const passwordSalts = req.body.passwordSalts
  const keySalts = req.body.keySalts

  const email = req.body.email
  const profile = req.body.profile
  const passwordBasedBackup = req.body.passwordBasedBackup

  let logChildObject
  try {
    logChildObject = { appId, username, req: trimReq(req) }
    logger.child(logChildObject).info('Signing up user')

    _validateSignUpInput(appId, username, passwordToken, publicKey, passwordSalts, keySalts, passwordBasedBackup, email, profile)

    const userId = uuidv4()

    // Warning: uses secondary index here. It's possible index won't be up to date and this fails
    const app = await appController.getAppByAppId(appId)
    if (!app || app['deleted']) {
      throw {
        status: statusCodes['Unauthorized'],
        error: {
          message: 'App ID not valid',
          deletedAppId: app && app['app-id']
        }
      }
    }

    const admin = await adminController.findAdminByAdminId(app['admin-id'])
    if (!admin || admin['deleted']) {
      throw {
        status: statusCodes['Unauthorized'],
        error: {
          message: 'App ID not valid',
          deletedAdminId: admin && admin['admin-id']
        }
      }
    } else {
      logChildObject.adminId = admin['admin-id']
    }

    await _validateSubscription(admin['stripe-saas-subscription-status'], admin['stripe-cancel-saas-subscription-at'], appId)

    const params = _buildSignUpParams(username, passwordToken, appId, userId,
      publicKey, passwordSalts, keySalts, email, profile, passwordBasedBackup)

    try {
      const ddbClient = connection.ddbClient()
      await ddbClient.put(params).promise()
    } catch (e) {
      if (e.name === 'ConditionalCheckFailedException') {
        throw {
          status: statusCodes['Conflict'],
          error: {
            message: 'UsernameAlreadyExists',
          }
        }
      }
      throw e
    }

    const session = await createSession(userId, appId)

    logger.child(logChildObject).info('Signed up user')

    return res.send({ userId, ...session })
  } catch (e) {
    const message = 'Failed to sign up user'

    if (e.status && e.error) {
      logger.child({ ...logChildObject, statusCode: e.status, err: e.error }).warn(message)
      return res.status(e.status).send(e.error.message)
    } else {
      const statusCode = statusCodes['Internal Server Error']
      logger.child({ ...logChildObject, statusCode, err: e }).error(message)
      return res.status(statusCode).send(message)
    }
  }
}

const _validateSession = function (session) {
  try {
    const doesNotExist = !session
    if (doesNotExist) throw { doesNotExist }

    const invalidated = session.invalidated
    if (invalidated) throw { invalidated }

    const sessionStartDate = new Date(session['extended-date'] || session['creation-date'])
    const expired = new Date() - sessionStartDate > SESSION_LENGTH
    if (expired) throw { expired }

    const isNotUserSession = expired || !session['user-id']
    if (isNotUserSession) throw { isNotUserSession }
  } catch (e) {
    throw {
      status: statusCodes['Unauthorized'],
      error: {
        message: 'Session invalid',
        ...e
      }
    }
  }
}

const _getSesssion = async function (sessionId) {
  const params = {
    TableName: setup.sessionsTableName,
    Key: {
      'session-id': sessionId
    }
  }

  const ddbClient = connection.ddbClient()
  const sessionResponse = await ddbClient.get(params).promise()

  return sessionResponse.Item
}

exports.authenticateUser = async function (req, res, next) {
  const sessionId = req.query.sessionId
  const appId = req.query.appId

  let logChildObject
  try {
    logChildObject = { appId, sessionId: truncateSessionId(sessionId), req: trimReq(req) }
    logger.child(logChildObject).info('Authenticating user')

    if (!sessionId || !appId) {
      throw { status: statusCodes['Unauthorized'], error: { message: 'Missing session token or app id' } }
    }

    const session = await _getSesssion(sessionId)
    _validateSession(session)

    const appDoesNotMatch = session['app-id'] !== appId
    if (appDoesNotMatch) {
      throw {
        status: statusCodes['Unauthorized'],
        error: {
          message: 'App ID not valid',
          appDoesNotMatch
        }
      }
    }

    // Warning: uses secondary indexes here. It's possible index won't be up to date and this fails
    const [user, app] = await Promise.all([
      getUserByUserId(session['user-id']),
      appController.getAppByAppId(session['app-id'])
    ])

    if (!user || user['deleted']) {
      throw {
        status: statusCodes['Unauthorized'],
        error: {
          message: 'Session invalid',
          deletedUserId: user && user['user-id']
        }
      }
    } else {
      logChildObject.userId = user['user-id']
    }

    if (!app || app['deleted']) {
      throw {
        status: statusCodes['Unauthorized'],
        error: {
          message: 'App ID not valid',
          deletedAppId: app && app['app-id'],
        }
      }
    }

    const admin = await adminController.findAdminByAdminId(app['admin-id'])
    if (!admin || admin['deleted']) {
      throw {
        status: statusCodes['Unauthorized'],
        error: {
          message: 'App ID not valid',
          deletedAdminId: admin && admin['admin-id'],
        }
      }
    } else {
      logChildObject.adminId = admin['admin-id']
    }

    // makes all the following objects available in next route
    res.locals.user = user
    res.locals.admin = admin
    res.locals.app = app
    res.locals.authToken = session['auth-token']

    logger.child(logChildObject).info('User authenticated')

    next()
  } catch (e) {
    const message = 'Failed to authenticate user'

    if (e.status && e.error) {
      logger.child({ ...logChildObject, statusCode: e.status, err: e.error }).warn(message)
      return res.status(e.status).send(e.error.message)
    } else {
      const statusCode = statusCodes['Internal Server Error']
      logger.child({ ...logChildObject, statusCode, err: e }).error(message)
      return res.status(statusCode).send(message)
    }
  }
}

const _getSessionByAuthToken = async (authToken) => {
  const params = {
    TableName: setup.sessionsTableName,
    IndexName: setup.authTokenIndex,
    KeyConditionExpression: '#authToken = :authToken',
    ExpressionAttributeNames: {
      '#authToken': 'auth-token'
    },
    ExpressionAttributeValues: {
      ':authToken': authToken
    },
    Select: 'ALL_ATTRIBUTES'
  }

  const ddbClient = connection.ddbClient()
  const sessionResponse = await ddbClient.query(params).promise()

  if (!sessionResponse || sessionResponse.Items.length === 0) return null

  if (sessionResponse.Items.length > 1) {
    // this should never happen
    const errorMsg = `Too many sessions found with auht token ${authToken.subString(0, 8)}`
    logger.fatal(errorMsg)
    throw new Error(errorMsg)
  }

  return sessionResponse.Items[0]
}

const _validateAuthToken = (authToken) => {
  try {
    if (typeof authToken !== 'string') throw 'Auth token must be a string.'
    if (authToken.length !== AUTH_TOKEN_STRING_LENGTH) throw 'Auth token is incorrect length.'
  } catch (e) {
    throw {
      status: statusCodes['Bad Request'],
      error: { message: e }
    }
  }
}

exports.verifyAuthToken = async function (req, res) {
  let logChildObject
  try {
    const admin = res.locals.admin
    const adminId = admin['admin-id']

    const authToken = req.params.authToken

    logChildObject = { adminId, req: trimReq(req) }
    logger.child(logChildObject).info('Verifying auth token')

    // verify auth token is string of correct length
    _validateAuthToken(authToken)

    const session = await _getSessionByAuthToken(authToken)

    // verify session exists, is not invalidated or expired, and is a session tied to a user
    try {
      _validateSession(session)
    } catch (e) {
      e.error.message = 'Auth token invalid.'
      throw e
    }

    const [user, app] = await Promise.all([
      getUserByUserId(session['user-id']),
      appController.getAppByAppId(session['app-id'])
    ])

    // verify auth token belongs to a user of an app owned by the admin
    if (app && app['admin-id'] !== adminId) {
      throw {
        status: statusCodes['Unauthorized'],
        error: {
          message: 'Auth token invalid.',
          incorrectAdminId: app['admin-id']
        }
      }
    }

    try {
      // verify app exists and is not deleted
      if (!app) {
        throw {
          message: 'App not found.'
        }
      } else if (app['deleted']) {
        throw {
          message: 'App was deleted.',
          deletedAppId: app['app-id'],
        }
      }

      logChildObject.appId = app['app-id']

      // verify user exists and is not deleted
      if (!user) {
        throw {
          message: 'User not found.'
        }
      } else if (user['deleted']) {
        throw {
          message: 'User was deleted.',
          deletedUserId: user['user-id']
        }
      }

      logChildObject.userId = user['user-id']

    } catch (error) {
      throw {
        status: statusCodes['Not Found'],
        error
      }
    }

    logger.child(logChildObject).info('Auth token verified')

    return res.send('Auth token verified!')
  } catch (e) {
    const message = 'Failed to verify auth token.'

    if (e.status && e.error) {
      logger.child({ ...logChildObject, statusCode: e.status, err: e.error }).info(message)
      return res.status(e.status).send({ message: e.error.message })
    } else {
      const statusCode = statusCodes['Internal Server Error']
      logger.child({ ...logChildObject, statusCode, err: e, }).error(message)
      return res.status(statusCode).send({ message })
    }
  }
}

const _getValidationMessage = (publicKey) => {
  const validationMessage = crypto.randomBytes(VALIDATION_MESSAGE_LENGTH)

  const publicKeyArrayBuffer = Buffer.from(publicKey, 'base64')
  const sharedSecret = crypto.diffieHellman.computeSecret(publicKeyArrayBuffer)
  const sharedKey = crypto.sha256.hash(sharedSecret)
  const encryptedValidationMessage = crypto.aesGcm.encrypt(sharedKey, validationMessage)

  return {
    validationMessage,
    encryptedValidationMessage
  }
}
exports.getValidationMessage = _getValidationMessage

const _buildStripeData = (admin, app, user) => {
  const stripeData = {}
  stripeData.stripeAccountId = admin['stripe-account-id']
  stripeData.paymentsMode = app['payments-mode'] || 'disabled'

  if (app['payments-mode'] === 'test') {
    stripeData.subscriptionStatus = user['test-subscription-status']
    stripeData.cancelSubscriptionAt = user['test-cancel-subscription-at']
  } else if (app['payments-mode'] === 'prod') {
    stripeData.subscriptionStatus = user['prod-subscription-status']
    stripeData.cancelSubscriptionAt = user['prod-cancel-subscription-at']
  }

  return stripeData
}

const userSavedSeed = async function (userId, appId, username, publicKey) {
  const updateUserParams = {
    TableName: setup.usersTableName,
    Key: {
      'username': username,
      'app-id': appId
    },
    UpdateExpression: 'remove #seedNotSavedYet',
    ConditionExpression: 'attribute_exists(#seedNotSavedYet) and #userId = :userId and #publicKey = :publicKey',
    ExpressionAttributeNames: {
      '#seedNotSavedYet': 'seed-not-saved-yet',
      '#userId': 'user-id',
      '#publicKey': 'public-key'
    },
    ExpressionAttributeValues: {
      ':userId': userId,
      ':publicKey': publicKey
    },
  }

  const ddbClient = connection.ddbClient()
  await ddbClient.update(updateUserParams).promise()
}

exports.validateKey = async function (validationMessage, userProvidedValidationMessage, conn, admin, app, user) {
  const seedNotSavedYet = user['seed-not-saved-yet']
  const userId = user['user-id']
  const appId = user['app-id']
  const username = user['username']
  const userPublicKey = user['public-key']

  if (validationMessage.toString('base64') === userProvidedValidationMessage) {
    try {
      if (seedNotSavedYet) {
        try {
          await userSavedSeed(userId, appId, username, userPublicKey)
        } catch (e) {
          if (e.name === 'ConditionalCheckFailedException') {
            return responseBuilder.errorResponse(statusCodes['Unauthorized'], 'Invalid seed')
          }

          throw e
        }
      }

      conn.validateKey()

      return responseBuilder.successResponse({ stripeData: _buildStripeData(admin, app, user) })
    } catch (e) {
      logger.error(`Failed to validate key with ${e}`)
      return responseBuilder.errorResponse(
        statusCodes['Internal Server Error'],
        'Failed to validate key'
      )
    }
  } else {
    return responseBuilder.errorResponse(statusCodes['Unauthorized'], 'Failed to validate key')
  }
}

exports.getPasswordSaltsByUserId = async function (userId) {
  try {
    const user = await getUserByUserId(userId)
    if (!user || user['deleted']) return responseBuilder.errorResponse(
      statusCodes['Not Found'],
      'User not found'
    )

    const result = {
      passwordSalt: user['password-salt'],
      passwordTokenSalt: user['password-token-salt']
    }

    return responseBuilder.successResponse(result)
  } catch (e) {
    logger.error(`User id '${userId}' failed to get password salts with ${e}`)
    return responseBuilder.errorResponse(statusCodes['Internal Server Error'])
  }
}

exports.getPasswordSaltsController = async function (req, res) {
  const appId = req.query.appId
  const username = req.query.username

  let logChildObject
  try {
    logChildObject = { appId, username, req: trimReq(req) }
    logger.child(logChildObject).info('Getting password salts over REST endpoint')

    if (!appId || !username) throw {
      status: statusCodes['Bad Request'],
      error: { message: 'Missing required items' }
    }

    try {
      _validateUsernameInput(username)
    } catch (e) {
      throw {
        status: statusCodes['Bad Request'],
        error: { message: e }
      }
    }

    // Warning: uses secondary index here. It's possible index won't be up to date and this fails
    const app = await appController.getAppByAppId(appId)
    if (!app || app['deleted']) {
      throw {
        status: statusCodes['Unauthorized'],
        error: {
          message: 'App ID not valid',
          deletedAppId: app && app['app-id'],
        }
      }
    }

    const admin = await adminController.findAdminByAdminId(app['admin-id'])
    if (!admin || admin['deleted']) {
      throw {
        status: statusCodes['Unauthorized'],
        error: {
          message: 'App ID not valid',
          deletedAdminId: admin && admin['admin-id'],
        }
      }
    } else {
      logChildObject.adminId = admin['admin-id']
    }

    const user = await getUser(appId, username.toLowerCase())

    // return salts even if user is deleted
    if (!user) {
      throw {
        status: statusCodes['Unauthorized'],
        error: {
          message: 'User not found',
        }
      }
    } else {
      logChildObject.userId = user['user-id']
    }

    const result = {
      passwordSalt: user['password-salt'],
      passwordTokenSalt: user['password-token-salt']
    }

    logger.child(logChildObject).info('Got password salts over REST endpoint')

    return res.send(result)
  } catch (e) {
    const message = 'Failed to get password salts over REST endpoint'

    if (e.status && e.error) {
      logger.child({ ...logChildObject, statusCode: e.status, err: e.error }).warn(message)
      return res.status(e.status).send(e.error.message)
    } else {
      const statusCode = statusCodes['Internal Server Error']
      logger.child({ ...logChildObject, statusCode, err: e }).error(message)
      return res.status(statusCode).send(message)
    }
  }
}

exports.signIn = async function (req, res) {
  const appId = req.query.appId

  const username = req.body.username
  const passwordToken = req.body.passwordToken

  let logChildObject
  try {
    logChildObject = { appId, username, req: trimReq(req) }
    logger.child(logChildObject).info('User signing in')

    if (!appId || !username || !passwordToken) {
      throw {
        status: statusCodes['Bad Request'],
        error: { message: 'Missing required items' }
      }
    }

    try {
      _validateUsernameInput(username)
    } catch (e) {
      throw {
        status: statusCodes['Bad Request'],
        error: { message: e }
      }
    }

    // Warning: uses secondary index here. It's possible index won't be up to date and this fails
    const app = await appController.getAppByAppId(appId)
    if (!app || app['deleted']) {
      throw {
        status: statusCodes['Unauthorized'],
        error: {
          message: 'App ID not valid',
          deletedAppId: app && app['app-id'],
        }
      }
    }

    const admin = await adminController.findAdminByAdminId(app['admin-id'])
    if (!admin || admin['deleted']) {
      throw {
        status: statusCodes['Unauthorized'],
        error: {
          message: 'App ID not valid',
          deletedAdminId: admin && admin['admin-id'],
        }
      }
    } else {
      logChildObject.adminId = admin['admin-id']
    }

    const user = await getUser(appId, username.toLowerCase())

    let usedTempPassword
    try {
      usedTempPassword = _validatePassword(passwordToken, user, req)
    } catch (e) {
      throw {
        status: statusCodes['Unauthorized'],
        error: { message: e.error === 'PasswordAttemptLimitExceeded' ? e : 'Invalid password' }
      }
    }

    logChildObject.userId = user['user-id']

    if (user['deleted']) throw {
      status: statusCodes['Forbidden'],
      error: {
        message: 'User pending deletion'
      }
    }

    const session = await createSession(user['user-id'], appId)

    const result = { session, userId: user['user-id'] }

    if (usedTempPassword) result.usedTempPassword = true
    if (user['email']) result.email = user['email']
    if (user['profile']) result.profile = user['profile']
    if (!usedTempPassword && user['password-based-encryption-key-salt'] && user['password-encrypted-seed']) {
      result.passwordBasedBackup = {
        passwordBasedEncryptionKeySalt: user['password-based-encryption-key-salt'],
        passwordEncryptedSeed: user['password-encrypted-seed']
      }
    }
    if (user['protected-profile']) result.protectedProfile = user['protected-profile']

    logger.child(logChildObject).info('User signed in')

    return res.send(result)
  } catch (e) {
    const message = 'User failed to sign in'

    if (e.status && e.error) {
      logger.child({ ...logChildObject, statusCode: e.status, err: e.error }).warn(message)
      return res.status(e.status).send(e.error.message)
    } else {
      const statusCode = statusCodes['Internal Server Error']
      logger.child({ ...logChildObject, statusCode, err: e }).error(message)
      return res.status(statusCode).send(message)
    }
  }
}

exports.signOut = async function (sessionId) {
  if (!sessionId) return responseBuilder.errorResponse(
    statusCodes['Unauthorized'],
    'Missing session id'
  )

  const params = {
    TableName: setup.sessionsTableName,
    Key: {
      'session-id': sessionId
    },
    UpdateExpression: 'set invalidated = :invalidated',
    ExpressionAttributeValues: {
      ':invalidated': true,
    }
  }

  try {
    const ddbClient = connection.ddbClient()
    await ddbClient.update(params).promise()

    return responseBuilder.successResponse('Success!')
  } catch (e) {
    logger.error(`Failed to sign out session ${sessionId} with ${e}`)
    return responseBuilder.errorResponse(
      statusCodes['Internal Server Error'],
      'Failed to sign out!'
    )
  }
}

async function getUserByUserId(userId) {
  const params = {
    TableName: setup.usersTableName,
    IndexName: setup.userIdIndex,
    KeyConditionExpression: '#userId = :userId',
    ExpressionAttributeNames: {
      '#userId': 'user-id'
    },
    ExpressionAttributeValues: {
      ':userId': userId
    },
    Select: 'ALL_ATTRIBUTES'
  }

  const ddbClient = connection.ddbClient()
  const userResponse = await ddbClient.query(params).promise()

  if (!userResponse || userResponse.Items.length === 0) return null

  if (userResponse.Items.length > 1) {
    const errorMsg = `Too many users found with id ${userId}`
    logger.fatal(errorMsg)
    throw new Error(errorMsg)
  }

  return userResponse.Items[0]
}
exports.getUserByUserId = getUserByUserId

const buildUserResult = (user) => {
  const result = {
    username: user['username'],
    userId: user['user-id'],
    appId: user['app-id'],
    creationDate: user['creation-date'],
  }

  if (user['email']) result['email'] = user['email']
  if (user['profile']) result['profile'] = user['profile']
  if (user['protected-profile']) result['protectedProfile'] = user['protected-profile']
  if (user['deleted']) result['deleted'] = user['deleted']

  if (user['test-stripe-customer-id']) {
    result.testStripeData = {
      customerId: user['test-stripe-customer-id'],
      subscriptionStatus: user['test-subscription-status'],
      cancelSubscriptionAt: user['test-cancel-subscription-at'],
      subscriptionId: user['test-subscription-id'],
      subscriptionPlanId: user['test-subscription-plan-id'],
    }
  }

  if (user['prod-stripe-customer-id']) {
    result.prodStripeData = {
      customerId: user['prod-stripe-customer-id'],
      subscriptionStatus: user['prod-subscription-status'],
      cancelSubscriptionAt: user['prod-cancel-subscription-at'],
      subscriptionId: user['prod-subscription-id'],
      subscriptionPlanId: user['prod-subscription-plan-id'],
    }
  }

  return result
}
exports.buildUserResult = buildUserResult

const adminGetUser = async (userId, adminId, logChildObject) => {
  const user = await getUserByUserId(userId)

  // allow return of deleted users
  if (!user) throw { status: statusCodes['Not Found'], error: { message: 'User not found.' } }

  const app = await appController.getAppByAppId(user['app-id'])
  if (!app || app['deleted']) {
    logChildObject.deletedAppId = app && app['app-id']
    throw {
      status: statusCodes['Not Found'],
      error: { message: 'User not found.' }
    }
  } else {
    logChildObject.appId = app['app-id']
  }

  // make sure admin is creator of app
  if (app['admin-id'] !== adminId) {
    logChildObject.incorrectAdminId = app['admin-id']
    throw {
      status: statusCodes['Forbidden'],
      error: { message: 'User not found.' }
    }
  }

  return { user, app }
}

exports.adminGetUserController = async function (req, res) {
  const logChildObject = res.locals.logChildObject

  try {
    const { userId } = req.params

    logChildObject.userId = userId
    logger.child(logChildObject).info('Admin getting user')

    _validateUserId(userId)

    const { user } = await adminGetUser(userId, res.locals.admin['admin-id'], logChildObject)

    logChildObject.statusCode = statusCodes['Success']
    logger.child(logChildObject).info('Successfully retrieved user for admin')

    return res.send(buildUserResult(user))
  } catch (e) {
    const message = 'Failed to retrieve user for admin.'

    if (e.status && e.error) {
      logger.child({ ...logChildObject, statusCode: e.status, err: e.error }).info(message)
      return res.status(e.status).send(e.error)
    } else {
      const statusCode = statusCodes['Internal Server Error']
      logger.child({ ...logChildObject, statusCode, err: e, }).error(message)
      return res.status(statusCode).send({ message })
    }
  }
}

exports.extendSession = async function (req, res) {
  const user = res.locals.user
  const admin = res.locals.admin
  const app = res.locals.app
  const authToken = res.locals.authToken

  const sessionId = req.query.sessionId

  let logChildObject
  try {
    logChildObject = { userId: user['user-id'], sessionId: truncateSessionId(sessionId), adminId: admin['admin-id'], app: app['app-id'], req: trimReq(req) }
    logger.child(logChildObject).info('Extending session')

    const extendedDate = new Date().toISOString()

    const params = {
      TableName: setup.sessionsTableName,
      Key: {
        'session-id': sessionId
      },
      UpdateExpression: 'set #extendedDate = :extendedDate, #ttl = :ttl',
      ExpressionAttributeNames: {
        '#extendedDate': 'extended-date',
        '#ttl': 'ttl'
      },
      ExpressionAttributeValues: {
        ':extendedDate': extendedDate,
        ':ttl': getTtl(SECONDS_IN_A_DAY)
      }
    }

    const ddbClient = connection.ddbClient()
    await ddbClient.update(params).promise()

    const result = { extendedDate, authToken, username: user['username'], userId: user['user-id'] }

    if (user['email']) result.email = user['email']
    if (user['profile']) result.profile = user['profile']
    result.backUpKey = (user['password-based-encryption-key-salt'] && user['password-encrypted-seed']) ? true : false
    if (user['protected-profile']) result.protectedProfile = user['protected-profile']

    logger.child(logChildObject).info('Extended session')

    return res.send(result)
  } catch (e) {
    const message = 'Failed to extend session'
    const statusCode = statusCodes['Internal Server Error']
    logger.child({ ...logChildObject, statusCode, err: e }).error(message)
    return res.status(statusCode).send(message)
  }
}

exports.getServerPublicKey = async function (req, res) {
  let logChildObject
  try {
    logChildObject = { req: trimReq(req) }
    logger.child(logChildObject).info('Getting server public key')

    return res.send(crypto.diffieHellman.getPublicKey())
  } catch (e) {
    const statusCode = statusCodes['Internal Server Error']
    const message = 'Failed to get server public key'

    logger.child({ ...logChildObject, statusCode, err: e }).error(message)
    return res.status().send(message)
  }
}

const _updateUserExcludingUsernameUpdate = async (user, userId, passwordToken, passwordSalts,
  email, profile, passwordBasedBackup) => {
  const updateUserParams = conditionCheckUserExists(user['username'], user['app-id'], userId)

  let UpdateExpression = ''

  if (passwordToken || email || profile) {
    UpdateExpression = 'SET '

    if (passwordToken) {
      UpdateExpression += '#passwordToken = :passwordToken, #passwordSalt = :passwordSalt, #passwordTokenSalt = :passwordTokenSalt'

      updateUserParams.ExpressionAttributeNames['#passwordToken'] = 'password-token'
      updateUserParams.ExpressionAttributeNames['#passwordSalt'] = 'password-salt'
      updateUserParams.ExpressionAttributeNames['#passwordTokenSalt'] = 'password-token-salt'

      updateUserParams.ExpressionAttributeValues[':passwordToken'] = crypto.sha256.hash(passwordToken)
      updateUserParams.ExpressionAttributeValues[':passwordSalt'] = passwordSalts.passwordSalt
      updateUserParams.ExpressionAttributeValues[':passwordTokenSalt'] = passwordSalts.passwordTokenSalt

      // password-based backup
      UpdateExpression += ', #passwordBasedEncryptionKeySalt = :passwordBasedEncryptionKeySalt, #passwordEncryptedSeed = :passwordEncryptedSeed'

      updateUserParams.ExpressionAttributeNames['#passwordBasedEncryptionKeySalt'] = 'password-based-encryption-key-salt'
      updateUserParams.ExpressionAttributeNames['#passwordEncryptedSeed'] = 'password-encrypted-seed'

      updateUserParams.ExpressionAttributeValues[':passwordBasedEncryptionKeySalt'] = passwordBasedBackup.passwordBasedEncryptionKeySalt
      updateUserParams.ExpressionAttributeValues[':passwordEncryptedSeed'] = passwordBasedBackup.passwordEncryptedSeed
    }

    if (email) {
      UpdateExpression += (passwordToken ? ', ' : '') + 'email = :email'
      updateUserParams.ExpressionAttributeValues[':email'] = email.toLowerCase()
    }

    if (profile) {
      UpdateExpression += ((passwordToken || email) ? ', ' : '') + 'profile = :profile'
      updateUserParams.ExpressionAttributeValues[':profile'] = profile
    }
  }

  if (email === false || profile === false) {
    UpdateExpression += ' REMOVE '

    if (email === false) {
      UpdateExpression += 'email'
    }

    if (profile === false) {
      UpdateExpression += (email === false ? ', ' : '') + 'profile'
    }
  }

  updateUserParams.UpdateExpression = UpdateExpression

  try {
    const ddbClient = connection.ddbClient()
    await ddbClient.update(updateUserParams).promise()
  } catch (e) {
    if (e.name === 'ConditionalCheckFailedException') {
      throw new Error('UserNotFound')
    }
    throw e
  }
}

const _updateUserIncludingUsernameUpdate = async (oldUser, userId, passwordToken,
  passwordSalts, email, profile, passwordBasedBackup, username) => {

  // if updating username, need to Delete existing DDB item and Put new one because username is partition key
  const deleteUserParams = conditionCheckUserExists(oldUser['username'], oldUser['app-id'], userId)

  const updatedUser = {
    ...oldUser,
    username: username.toLowerCase()
  }

  if (passwordToken) {
    updatedUser['password-token'] = crypto.sha256.hash(passwordToken)
    updatedUser['password-salt'] = passwordSalts.passwordSalt
    updatedUser['password-token-salt'] = passwordSalts.passwordTokenSalt

    updatedUser['password-based-encryption-key-salt'] = passwordBasedBackup.passwordBasedEncryptionKeySalt
    updatedUser['password-encrypted-seed'] = passwordBasedBackup.passwordEncryptedSeed
  }

  if (email) updatedUser.email = email.toLowerCase()
  else if (email === false) delete updatedUser.email

  if (profile) updatedUser.profile = profile
  else if (profile === false) delete updatedUser.profile

  const updateUserParams = {
    TableName: setup.usersTableName,
    Item: updatedUser,
    // if username does not exist, insert
    // if it already exists and user hasn't saved seed yet, overwrite
    // if it already exists and user has saved seed, fail with ConditionalCheckFailedException
    ConditionExpression: 'attribute_not_exists(username) or attribute_exists(#seedNotSavedYet)',
    ExpressionAttributeNames: {
      '#seedNotSavedYet': 'seed-not-saved-yet'
    }
  }

  const params = {
    TransactItems: [
      { Delete: deleteUserParams },
      { Put: updateUserParams }
    ]
  }

  try {
    const ddbClient = connection.ddbClient()
    await ddbClient.transactWrite(params).promise()
  } catch (e) {
    if (e.message.includes('[ConditionalCheckFailed')) {
      throw new Error('UserNotFound')
    } else if (e.message.includes('ConditionalCheckFailed]')) {
      throw new Error('UsernameAlreadyExists')
    }
    throw e
  }
}

exports.updateUser = async function (userId, username, currentPasswordToken, passwordToken, passwordSalts,
  email, profile, passwordBasedBackup) {
  if (!username && !currentPasswordToken && !passwordToken && !email && !profile && email !== false && profile !== false) {
    return responseBuilder.errorResponse(statusCodes['Bad Request'], 'Missing all params')
  }

  if (passwordToken) {
    if (!passwordSalts || !passwordSalts.passwordSalt || !passwordSalts.passwordTokenSalt) {
      return responseBuilder.errorResponse(statusCodes['Bad Request'], 'Missing password salts')

    } else if (!passwordBasedBackup || !passwordBasedBackup.passwordBasedEncryptionKeySalt
      || !passwordBasedBackup.passwordEncryptedSeed) {

      return responseBuilder
        .errorResponse(statusCodes['Bad Request'], 'Missing password-based key backup')

    } else if (!currentPasswordToken) {
      return responseBuilder
        .errorResponse(statusCodes['Bad Request'], 'Missing current password token')
    }
  }

  try {
    if (username) _validateUsernameInput(username)
    if (email && !validateEmail(email)) throw { error: 'EmailNotValid' }
    if (profile) _validateProfile(profile)
  } catch (e) {
    return responseBuilder.errorResponse(statusCodes['Bad Request'], e)
  }

  try {
    const user = await getUserByUserId(userId)
    if (!user || user['deleted']) throw new Error('UserNotFound')

    if (passwordToken) {
      try {
        _validatePassword(currentPasswordToken, user)
      } catch (e) {
        if (e.error === 'PasswordAttemptLimitExceeded') {
          return responseBuilder.errorResponse(status(statusCodes['Unauthorized']), e)
        }

        return responseBuilder.errorResponse(statusCodes['Bad Request'], 'CurrentPasswordIncorrect')
      }
    }

    if (username && username.toLowerCase() !== user['username']) {

      await _updateUserIncludingUsernameUpdate(
        user, userId, passwordToken, passwordSalts, email, profile, passwordBasedBackup, username
      )

    } else if (passwordToken || (email || email === false) || (profile || profile === false)) {

      await _updateUserExcludingUsernameUpdate(
        user, userId, passwordToken, passwordSalts, email, profile, passwordBasedBackup
      )

    }

    return responseBuilder.successResponse()
  } catch (e) {
    if (e.message === 'UserNotFound') return responseBuilder.errorResponse(statusCodes['Not Found'], 'UserNotFound')
    else if (e.message === 'UsernameAlreadyExists') return responseBuilder.errorResponse(statusCodes['Conflict'], 'UsernameAlreadyExists')

    logger.error(`Failed to update user '${userId}' with ${e}`)
    return responseBuilder.errorResponse(statusCodes['Internal Server Error'], 'Failed to update user')
  }
}

const deleteUser = async (user, stripeAccountId) => {
  // First: delete user's Stripe subscriptions so long as admin has Stripe account connected
  const testSubscriptionId = user['test-subscription-id']
  const testSubscriptionStatus = user['test-subscription-status']
  const useTestClient = true

  const prodSubscriptionId = user['prod-subscription-id']
  const prodSubscriptionStatus = user['prod-subscription-status']

  await Promise.all([
    stripeAccountId && stripe.deleteSubscription(testSubscriptionId, testSubscriptionStatus, stripeAccountId, useTestClient),
    stripeAccountId && stripe.deleteSubscription(prodSubscriptionId, prodSubscriptionStatus, stripeAccountId),
  ])

  // Second: delete user from DDB
  const params = conditionCheckUserExists(user['username'], user['app-id'], user['user-id'])

  params.UpdateExpression = 'set deleted = :deleted'
  params.ExpressionAttributeValues[':deleted'] = new Date().toISOString()

  const ddbClient = connection.ddbClient()
  await ddbClient.update(params).promise()
}
exports.deleteUser = deleteUser

exports.deleteUserController = async function (userId, adminId, appName, stripeAccountId) {
  try {
    if (!userId || !adminId || !appName) return responseBuilder
      .errorResponse(statusCodes['Bad Request'], 'Missing params')

    const user = await getUserByUserId(userId)
    if (!user || user['deleted']) return responseBuilder.errorResponse(statusCodes['Not Found'], 'UserNotFound')

    await deleteUser(user, stripeAccountId)

    return responseBuilder.successResponse()
  } catch (e) {
    if (e.name === 'ConditionalCheckFailedException') {
      return responseBuilder.errorResponse(statusCodes['Not Found'], 'UserNotFound')
    }

    logger.error(`Failed to delete user '${userId}' with ${e}`)
    return responseBuilder.errorResponse(statusCodes['Internal Server Error'], 'Failed to delete user')
  }
}

const updateProtectedProfile = async function (username, appId, userId, protectedProfile) {
  const updateUserParams = conditionCheckUserExists(username, appId, userId)

  updateUserParams.ExpressionAttributeNames['#protectedProfile'] = 'protected-profile'

  let UpdateExpression
  if (protectedProfile) {
    UpdateExpression = 'SET #protectedProfile = :protectedProfile'
    updateUserParams.ExpressionAttributeValues[':protectedProfile'] = protectedProfile
  } else {
    UpdateExpression = 'REMOVE #protectedProfile'
  }

  updateUserParams.UpdateExpression = UpdateExpression

  try {
    const ddbClient = connection.ddbClient()
    await ddbClient.update(updateUserParams).promise()
  } catch (e) {
    if (e.name === 'ConditionalCheckFailedException') {
      throw { status: statusCodes['Not Found'], error: { message: 'User not found' } }
    }
    throw e
  }
}

const _validateUserId = (userId) => {
  if (!userId) throw { status: statusCodes['Bad Request'], error: { message: 'User ID missing.' } }
  if (typeof userId !== 'string') throw { status: statusCodes['Bad Request'], error: { message: 'User ID must be a string.' } }
  if (userId.length !== UUID_STRING_LENGTH) throw { status: statusCodes['Bad Request'], error: { message: 'User ID is incorrect length.' } }
}

exports.updateProtectedProfile = async function (req, res) {
  const logChildObject = res.locals.logChildObject

  try {
    const { userId } = req.params
    const { protectedProfile } = req.body

    logger.child(logChildObject).info('Updating protected profile')

    _validateUserId(userId)

    if (!Object.prototype.hasOwnProperty.call(req.body, 'protectedProfile')) {
      throw { status: statusCodes['Bad Request'], error: { message: 'Protected profile missing.' } }
    }

    try {
      // if falsey, it gets deleted
      if (protectedProfile) _validateProfile(protectedProfile)
    } catch (e) {
      const name = e.error
      delete e.error
      throw { status: statusCodes['Bad Request'], error: { name, ...e } }
    }

    const { user, app } = await adminGetUser(userId, res.locals.admin['admin-id'], logChildObject)
    if (user['deleted']) throw { status: statusCodes['Not Found'], error: { message: 'User not found' } }

    await updateProtectedProfile(user['username'], app['app-id'], userId, protectedProfile)

    logChildObject.statusCode = statusCodes['Success']
    logger.child(logChildObject).info('Successfully updated protected profile')

    return res.end()
  } catch (e) {
    const message = 'Failed to update protected profile.'

    if (e.status && e.error) {
      logger.child({ ...logChildObject, statusCode: e.status, err: e.error }).info(message)
      return res.status(e.status).send(e.error)
    } else {
      const statusCode = statusCodes['Internal Server Error']
      logger.child({ ...logChildObject, statusCode, err: e }).error(message)
      return res.status(statusCode).send({ message })
    }
  }
}

const getUser = async function (appId, username) {
  const userParams = {
    TableName: setup.usersTableName,
    Key: {
      'app-id': appId,
      username
    }
  }

  const ddbClient = connection.ddbClient()
  const userResponse = await ddbClient.get(userParams).promise()

  return userResponse && userResponse.Item
}

const _precheckGenerateForgotPasswordToken = async function (appId, username) {
  if (!appId || !username) {
    throw { status: statusCodes['Bad Request'], error: { message: 'Missing required items' } }
  }

  try {
    _validateUsernameInput(username)
  } catch (e) {
    const name = e.error
    delete e.error
    throw { status: statusCodes['Bad Request'], error: { name, ...e } }
  }

  const app = await appController.getAppByAppId(appId)
  if (!app || app['deleted']) {
    throw { status: statusCodes['Unauthorized'], error: { name: 'AppIdNotValid' } }
  }

  const [admin, user] = await Promise.all([
    adminController.findAdminByAdminId(app['admin-id']),
    getUser(appId, username)
  ])

  if (!admin || admin['deleted']) {
    throw { status: statusCodes['Unauthorized'], error: { name: 'AppIdNotValid' } }
  } else if (!user || user['deleted']) {
    throw { status: statusCodes['Not Found'], error: { name: 'UserNotFound' } }
  } else if (!user['email']) {
    throw { status: statusCodes['Not Found'], error: { name: 'UserEmailNotFound' } }
  }

  return { user, app, admin }
}

exports.generateForgotPasswordToken = async function (req, appId, username) {
  try {
    logger.child({ appId, username, req: trimReq(req) }).info('Generating forgot password token')

    const { user, app, admin } = await _precheckGenerateForgotPasswordToken(appId, username)

    const { validationMessage, encryptedValidationMessage } = _getValidationMessage(user['public-key'])

    logger
      .child({ appId, username, userId: user['user-id'], statusCode: statusCodes['Success'], req: trimReq(req) })
      .info('Successfully generated forgot password token')

    const forgotPasswordToken = validationMessage
    const encryptedForgotPasswordToken = encryptedValidationMessage

    return responseBuilder.successResponse({ user, app, admin, forgotPasswordToken, encryptedForgotPasswordToken })
  } catch (e) {
    const message = 'Failed to generate forgot password token.'

    if (e.status && e.error) {
      logger.child({ appId, username, statusCode: e.status, err: e.error, req: trimReq(req) }).warn(message)
      return responseBuilder.errorResponse(e.status, e.error)
    } else {
      const statusCode = statusCodes['Internal Server Error']
      logger.child({ appId, username, statusCode, err: e, req: trimReq(req) }).error(message)
      return responseBuilder.errorResponse(statusCode, message)
    }
  }
}

const _setTempPasswordToken = async (username, appId, userId, tempPasswordToken) => {
  const params = conditionCheckUserExists(username, appId, userId)

  params.UpdateExpression = 'set #tempPasswordToken = :tempPasswordToken, #tempPasswordCreationDate = :tempPasswordCreationDate'

  params.ExpressionAttributeNames = {
    ...params.ExpressionAttributeNames,
    '#tempPasswordToken': 'temp-password-token',
    '#tempPasswordCreationDate': 'temp-password-creation-date'
  }

  params.ExpressionAttributeValues = {
    ...params.ExpressionAttributeValues,
    ':tempPasswordToken': crypto.sha256.hash(tempPasswordToken),
    ':tempPasswordCreationDate': new Date().toISOString()
  }

  const ddbClient = connection.ddbClient()
  await ddbClient.update(params).promise()
}

// matches userbase-js password token generation
const _generateTempPasswordToken = async (tempPassword, passwordSalt, passwordTokenSalt) => {
  const tempPasswordHash = await crypto.scrypt.hash(tempPassword, new Uint8Array(Buffer.from(passwordSalt, 'base64')))
  const tempPasswordToken = await crypto.hkdf.getPasswordToken(tempPasswordHash, Buffer.from(passwordTokenSalt, 'base64'))
  return tempPasswordToken
}

exports.forgotPassword = async function (req, forgotPasswordToken, userProvidedForgotPasswordToken, user, app) {
  const userId = user['user-id']
  const appId = app['app-id']

  let logChildObject
  try {
    logChildObject = { userId, appId, req: trimReq(req) }
    logger.child(logChildObject).info('User forgot password')

    // check if client decrypted forgot password token successfully
    if (forgotPasswordToken.toString('base64') !== userProvidedForgotPasswordToken) {
      throw { status: statusCodes['Unauthorized'], error: { name: 'KeyNotValid' } }
    }

    const tempPassword = crypto
      .randomBytes(ACCEPTABLE_RANDOM_BYTES_FOR_SAFE_SESSION_ID)
      .toString('base64')

    const tempPasswordToken = await _generateTempPasswordToken(tempPassword, user['password-salt'], user['password-token-salt'])
    await _setTempPasswordToken(user['username'], appId, userId, tempPasswordToken)

    const subject = `Forgot password - ${app['app-name']}`
    const body = `Hello, ${user['username']}!`
      + '<br />'
      + '<br />'
      + `Someone has requested you forgot your password to ${app['app-name']}!`
      + '<br />'
      + '<br />'
      + 'If you did not make this request, you can safely ignore this email.'
      + '<br />'
      + '<br />'
      + `Here is your temporary password you can use to log in and change your password with: ${tempPassword}`
      + '<br />'
      + '<br />'
      + `This password will expire in ${HOURS_IN_A_DAY} hours.`

    await setup.sendEmail(user['email'], subject, body)

    logger.child(logChildObject).info('Successfully forgot password')
    return responseBuilder.successResponse()
  } catch (e) {
    const message = 'Failed to forget password'

    if (e.status && e.error) {
      logger.child({ ...logChildObject, statusCode: e.status, err: e.error }).warn(message)
      return responseBuilder.errorResponse(e.status, e.error)
    } else {
      const statusCode = statusCodes['Internal Server Error']
      logger.child({ ...logChildObject, statusCode, err: e }).error(message)
      return responseBuilder.errorResponse(statusCode, message)
    }
  }
}

exports.permanentDelete = async function (user) {
  const username = user['username']
  const appId = user['app-id']
  const userId = user['user-id']

  const logChildObject = { username, appId, userId }
  logger.child(logChildObject).info('Permanent deleting user')

  const existingUserParams = {
    TableName: setup.usersTableName,
    Key: {
      username,
      'app-id': appId
    },
    ConditionExpression: 'attribute_exists(deleted) and #userId = :userId',
    ExpressionAttributeNames: {
      '#userId': 'user-id'
    },
    ExpressionAttributeValues: {
      ':userId': userId
    }
  }

  const permanentDeletedUserParams = {
    TableName: setup.deletedUsersTableName,
    Item: {
      ...user // still technically can recover user before data is purged, though more difficult
    },
    ConditionExpression: 'attribute_not_exists(#userId)',
    ExpressionAttributeNames: {
      '#userId': 'user-id'
    },
  }

  const transactionParams = {
    TransactItems: [
      { Delete: existingUserParams },
      { Put: permanentDeletedUserParams }
    ]
  }

  const ddbClient = connection.ddbClient()
  await ddbClient.transactWrite(transactionParams).promise()

  logger.child(logChildObject).info('Deleted user permanently')
}

const conditionCheckUserExists = (username, appId, userId) => {
  return {
    TableName: setup.usersTableName,
    Key: {
      username,
      'app-id': appId
    },
    ConditionExpression: 'attribute_exists(username) and #userId = :userId',
    ExpressionAttributeNames: {
      '#userId': 'user-id'
    },
    ExpressionAttributeValues: {
      ':userId': userId
    }
  }
}

const _createStripePaymentSession = async function (user, admin, subscriptionPlanId, customerId, success_url, cancel_url, useTestClient) {
  const stripeAccountId = admin['stripe-account-id']

  try {
    const session = await stripe.getClient(useTestClient).checkout.sessions.create({
      customer_email: user['email'],
      customer: customerId,
      client_reference_id: user['user-id'],
      payment_method_types: ['card'],
      subscription_data: {
        items: [{
          plan: subscriptionPlanId,
        }],
        trial_from_plan: true,
        metadata: {
          __userbase_user_id: user['user-id'],
          __userbase_admin_id: admin['admin-id'],
          __userbase_app_id: user['app-id'],
        }
      },
      success_url,
      cancel_url,
    },
      { stripe_account: stripeAccountId }
    )

    return session
  } catch (e) {
    if (e.code === 'url_invalid') {
      throw {
        status: statusCodes['Bad Request'],
        error: e.param === 'success_url'
          ? 'SuccessUrlInvalid'
          : 'CancelUrlInvalid'
      }
    } else {
      throw {
        status: e.statusCode,
        error: {
          name: 'StripeError',
          type: e.type,
          message: e.message,
        }
      }
    }
  }
}

exports.createSubscriptionPaymentSession = async function (logChildObject, app, admin, user, success_url, cancel_url) {
  try {
    const stripeAccountId = admin['stripe-account-id']
    logChildObject.stripeAccountId = stripeAccountId
    logChildObject.userEmail = user['email']
    logger.child(logChildObject).info('Creating payment session for user')

    let subscriptionPlanId, userPlanId, subscriptionStatus, customerId
    if (app['payments-mode'] === 'prod' && adminController.prodPaymentsEnabled(admin)) {
      subscriptionPlanId = app['prod-subscription-plan-id']
      userPlanId = user['prod-subscription-plan-id']
      subscriptionStatus = user['prod-subscription-status']
      customerId = user['prod-stripe-customer-id']
    } else if (app['payments-mode'] === 'test') {
      subscriptionPlanId = app['test-subscription-plan-id']
      userPlanId = user['test-subscription-plan-id']
      subscriptionStatus = user['test-subscription-status']
      customerId = user['test-stripe-customer-id']
    } else {
      throw {
        status: statusCodes['Forbidden'],
        error: 'PaymentsDisabled'
      }
    }

    logChildObject.subscriptionPlanId = subscriptionPlanId
    logChildObject.customerId = customerId

    if (!subscriptionPlanId) throw {
      status: statusCodes['Forbidden'],
      error: 'SubscriptionPlanNotSet'
    }

    if (userPlanId === subscriptionPlanId && subscriptionStatus !== 'canceled') {
      throw {
        status: statusCodes['Conflict'],
        error: 'SubscriptionPlanAlreadyPurchased'
      }
    }

    const session = await _createStripePaymentSession(user, admin, subscriptionPlanId, customerId, success_url, cancel_url, app['payments-mode'] === 'test')

    logger
      .child({ ...logChildObject, statusCode: statusCodes['Success'] })
      .info('Successfully created payment session for user')

    return responseBuilder.successResponse(session.id)
  } catch (e) {
    const message = 'Failed to create payment session for user.'

    if (e.status && e.error) {
      logger.child({ ...logChildObject, statusCode: e.status, err: e.error }).error(message)
      return responseBuilder.errorResponse(e.status, e.error)
    } else {
      const statusCode = statusCodes['Internal Server Error']

      logger.child({ ...logChildObject, statusCode, err: e }).error(message)
      return responseBuilder.errorResponse(statusCode, message)
    }
  }
}

const _buildStripeSubscriptionDdbParams = async (user, customerId, subscriptionId, planId, status, cancelAt, stripeEventTimestamp, isProduction) => {
  const stripeSubscriptionDdbParams = conditionCheckUserExists(user['username'], user['app-id'], user['user-id'])

  // Making sure event timestamp provided is greater than one stored ensures latest gets stored in DDB (Stripe sends events out of order)
  stripeSubscriptionDdbParams.ConditionExpression += ' and (attribute_not_exists(#stripeEventTimestamp) or #stripeEventTimestamp < :stripeEventTimestamp)'

  stripeSubscriptionDdbParams.UpdateExpression = `SET
    #stripeCustomerId = :stripeCustomerId,
    #stripeSubscriptionId = :stripeSubscriptionId,
    #stripePlanId = :stripePlanId,
    #stripeSubscriptionStatus = :stripeSubscriptionStatus,
    #stripeEventTimestamp = :stripeEventTimestamp
  `

  stripeSubscriptionDdbParams.ExpressionAttributeNames['#stripeCustomerId'] = (isProduction ? 'prod' : 'test') + '-stripe-customer-id'
  stripeSubscriptionDdbParams.ExpressionAttributeNames['#stripeSubscriptionId'] = (isProduction ? 'prod' : 'test') + '-subscription-id'
  stripeSubscriptionDdbParams.ExpressionAttributeNames['#stripePlanId'] = (isProduction ? 'prod' : 'test') + '-subscription-plan-id'
  stripeSubscriptionDdbParams.ExpressionAttributeNames['#stripeSubscriptionStatus'] = (isProduction ? 'prod' : 'test') + '-subscription-status'
  stripeSubscriptionDdbParams.ExpressionAttributeNames['#stripeEventTimestamp'] = (isProduction ? 'prod' : 'test') + '-stripe-event-timestamp'
  stripeSubscriptionDdbParams.ExpressionAttributeNames['#cancelAt'] = (isProduction ? 'prod' : 'test') + '-cancel-subscription-at'

  stripeSubscriptionDdbParams.ExpressionAttributeValues[':stripeCustomerId'] = customerId
  stripeSubscriptionDdbParams.ExpressionAttributeValues[':stripeSubscriptionId'] = subscriptionId
  stripeSubscriptionDdbParams.ExpressionAttributeValues[':stripePlanId'] = planId
  stripeSubscriptionDdbParams.ExpressionAttributeValues[':stripeSubscriptionStatus'] = status
  stripeSubscriptionDdbParams.ExpressionAttributeValues[':stripeEventTimestamp'] = stripeEventTimestamp

  if (!cancelAt) {
    stripeSubscriptionDdbParams.UpdateExpression += ' REMOVE #cancelAt'
  } else {
    stripeSubscriptionDdbParams.UpdateExpression += ', #cancelAt = :cancelAt'
    stripeSubscriptionDdbParams.ExpressionAttributeValues[':cancelAt'] = cancelAt
  }

  return stripeSubscriptionDdbParams
}

exports.updateSubscriptionInDdb = async (logChildObject, logs, metadata, customerId, subscriptionId, subscriptionPlanId, status, cancelAt, stripeEventTimestamp, isProduction, stripeAccountId) => {
  try {
    const userId = metadata.__userbase_user_id
    const adminId = metadata.__userbase_admin_id
    const appId = metadata.__userbase_app_id

    logChildObject.userId = userId
    logChildObject.adminId = adminId
    logChildObject.appId = appId
    logger.child(logChildObject).info(logs.startingLog)

    if (!userId) throw new Error('MissingUserIdFromUserSubscriptionMetadata')
    if (!appId) throw new Error('MissingAppIdFromUserSubscriptionMetadata')
    if (!adminId) throw new Error('MissingAdminIdFromUserSubscriptionMetadata')

    const [admin, app, user] = await Promise.all([
      adminController.findAdminByAdminId(adminId),
      appController.getAppByAppId(appId),
      getUserByUserId(userId)
    ])

    // possible these were deleted from DDB before Stripe called the webhook
    if (!admin || !app || !user) throw new Error('MissingFromDdb')

    // possible the admin altered metadata fields to be valid, existing ID's
    if (app['admin-id'] !== adminId) throw new Error('IncorrectAppIdInMetadata')
    if (user['app-id'] !== appId) throw new Error('IncorrectUserIdInMetadata')

    // possible admin has disconnected or changed their Stripe Connect account but there is a user still subscribed to a plan
    // the admin created with a prior Stripe Connect account
    if (admin['stripe-account-id'] !== stripeAccountId) throw new Error('IncorrectStripeAccount')

    // possible admin has deleted or changed the Stripe Plan ID in the admin panel, but there is a user still subscribed to a prior plan
    // the admin had stored
    if ((isProduction && app['prod-subscription-plan-id'] !== subscriptionPlanId) ||
      (!isProduction && app['test-subscription-plan-id'] !== subscriptionPlanId)
    ) {
      throw new Error('IncorrectSubscriptionPlanId')
    }

    const updateUserParams = await _buildStripeSubscriptionDdbParams(user, customerId, subscriptionId, subscriptionPlanId, status, cancelAt, stripeEventTimestamp, isProduction, stripeAccountId)
    const ddbClient = connection.ddbClient()
    await ddbClient.update(updateUserParams).promise()
  } catch (e) {
    switch (e.message) {
      case 'MissingUserIdFromUserSubscriptionMetadata':
      case 'MissingAppIdFromUserSubscriptionMetadata':
      case 'MissingAdminIdFromUserSubscriptionMetadata':
      case 'MissingFromDdb':
      case 'IncorrectAppIdInMetadata':
      case 'IncorrectUserIdInMetadata':
      case 'IncorrectStripeAccount':
      case 'IncorrectSubscriptionPlanId': {
        // if error is any one of the above, no need to make the webhook throw
        logger.child({ ...logChildObject, err: e }).warn(logs.issueLog)
        break
      }

      default:
        throw e
    }

  }
}

const _throwPaymentErrors = (subscriptionPlanNotSet, subscriptionNotFound, subscribedToIncorrectPlan, subscriptionInactive, subscriptionStatus) => {
  if (subscriptionPlanNotSet) {
    throw {
      status: statusCodes['Forbidden'],
      error: {
        name: 'SubscriptionPlanNotSet'
      }
    }
  } else if (subscriptionNotFound) {
    throw {
      status: statusCodes['Not Found'],
      error: {
        name: 'SubscriptionNotFound'
      }
    }
  } else if (subscribedToIncorrectPlan) {
    throw {
      status: statusCodes['Payment Required'],
      error: {
        name: 'SubscribedToIncorrectPlan'
      }
    }
  } else if (subscriptionInactive) {
    throw {
      status: statusCodes['Payment Required'],
      error: {
        name: 'SubscriptionInactive',
        subscriptionStatus
      }
    }
  }
}

exports.validatePayment = function (user, app, admin) {
  if (app['payments-mode'] !== 'prod' && app['payments-mode'] !== 'test') return

  // payments mode set to prod but subscriptions not paid for gets same functional treatment as disabled payments mode
  if (app['payments-mode'] === 'prod' && !adminController.prodPaymentsEnabled(admin)) return

  const prefix = app['payments-mode'] === 'prod' ? 'prod' : 'test'

  const subscriptionPlanNotSet = !app[prefix + '-subscription-plan-id']

  const subscriptionNotFound = !user[prefix + '-subscription-plan-id']

  const subscribedToIncorrectPlan = app[prefix + '-subscription-plan-id'] !== user[prefix + '-subscription-plan-id']

  const subscriptionStatus = user[prefix + '-subscription-status']
  const subscriptionInactive = subscriptionStatus !== 'active' && subscriptionStatus !== 'trialing'

  _throwPaymentErrors(subscriptionPlanNotSet, subscriptionNotFound, subscribedToIncorrectPlan, subscriptionInactive, subscriptionStatus)
}

const _cancelStripeSubscriptionInDdb = async (user, isProduction, cancel_at) => {
  const updateUserParams = conditionCheckUserExists(user['username'], user['app-id'], user['user-id'])

  const cancelAt = stripe.convertStripeTimestamptToIsoString(cancel_at)

  updateUserParams.UpdateExpression = 'SET #cancelAt = :cancelAt'
  updateUserParams.ExpressionAttributeNames['#cancelAt'] = (isProduction ? 'prod' : 'test') + '-cancel-subscription-at'
  updateUserParams.ExpressionAttributeValues[':cancelAt'] = cancelAt

  try {
    const ddbClient = connection.ddbClient()
    await ddbClient.update(updateUserParams).promise()
    return cancelAt
  } catch (e) {
    if (e.name === 'ConditionalCheckFailedException') {
      throw new Error('UserNotFound')
    }
    throw e
  }
}

const _resumeStripeSubscriptionInDdb = async (user, isProduction) => {
  const updateUserParams = conditionCheckUserExists(user['username'], user['app-id'], user['user-id'])

  updateUserParams.UpdateExpression = 'REMOVE #cancelAt'
  updateUserParams.ExpressionAttributeNames['#cancelAt'] = (isProduction ? 'prod' : 'test') + '-cancel-subscription-at'

  try {
    const ddbClient = connection.ddbClient()
    await ddbClient.update(updateUserParams).promise()
  } catch (e) {
    if (e.name === 'ConditionalCheckFailedException') {
      throw new Error('UserNotFound')
    }
    throw e
  }
}

const _validateModifySubscription = (logChildObject, app, user) => {
  let subscriptionId, isProduction
  if (app['payments-mode'] === 'prod') {
    subscriptionId = user['prod-subscription-id']
    isProduction = true
  } else if (app['payments-mode'] === 'test') {
    subscriptionId = user['test-subscription-id']
  } else {
    throw {
      status: statusCodes['Forbidden'],
      error: 'PaymentsDisabled'
    }
  }

  logChildObject.subscriptionId = subscriptionId

  if (!subscriptionId) throw {
    status: statusCodes['Forbidden'],
    error: 'SubscriptionPlanNotSet'
  }

  return { subscriptionId, isProduction }
}


exports.cancelSubscription = async function (logChildObject, app, admin, user) {
  try {
    const stripeAccountId = admin['stripe-account-id']
    logChildObject.stripeAccountId = stripeAccountId
    logger.child(logChildObject).info('Cancelling user subscription')

    const { subscriptionId, isProduction } = _validateModifySubscription(logChildObject, app, user)
    const useTestClient = !isProduction

    const updatedSubscription = await stripe.getClient(useTestClient).subscriptions.update(
      subscriptionId,
      { cancel_at_period_end: true },
      { stripe_account: stripeAccountId }
    )

    const cancelAt = await _cancelStripeSubscriptionInDdb(user, isProduction, updatedSubscription.cancel_at)

    logger
      .child({ ...logChildObject, statusCode: statusCodes['Success'] })
      .info('Successfully cancelled user subscription')

    return responseBuilder.successResponse(cancelAt)
  } catch (e) {
    const message = 'Failed to cancel subscription for user.'

    if (e.status && e.error) {
      logger.child({ ...logChildObject, statusCode: e.status, err: e.error }).error(message)
      return responseBuilder.errorResponse(e.status, e.error)
    } else {
      const statusCode = statusCodes['Internal Server Error']

      logger.child({ ...logChildObject, statusCode, err: e }).error(message)
      return responseBuilder.errorResponse(statusCode, message)
    }
  }
}

exports.resumeSubscription = async function (logChildObject, app, admin, user) {
  try {
    const stripeAccountId = admin['stripe-account-id']
    logChildObject.stripeAccountId = stripeAccountId
    logger.child(logChildObject).info('Resuming user subscription')

    const { subscriptionId, isProduction } = _validateModifySubscription(logChildObject, app, user)
    const useTestClient = !isProduction

    await stripe.getClient(useTestClient).subscriptions.update(
      subscriptionId,
      { cancel_at_period_end: false },
      { stripe_account: stripeAccountId }
    )

    await _resumeStripeSubscriptionInDdb(user, isProduction)

    logger
      .child({ ...logChildObject, statusCode: statusCodes['Success'] })
      .info('Successfully resumed user subscription')

    return responseBuilder.successResponse()
  } catch (e) {
    const message = 'Failed to resume subscription for user.'

    if (e.status && e.error) {
      logger.child({ ...logChildObject, statusCode: e.status, err: e.error }).error(message)
      return responseBuilder.errorResponse(e.status, e.error)
    } else {
      const statusCode = statusCodes['Internal Server Error']

      logger.child({ ...logChildObject, statusCode, err: e }).error(message)
      return responseBuilder.errorResponse(statusCode, message)
    }
  }
}

const _createStripeUpdatePaymentMethodSession = async function (user, admin, customer_id, subscription_id, success_url, cancel_url, useTestClient) {
  const stripeAccountId = admin['stripe-account-id']

  try {
    const session = await stripe.getClient(useTestClient).checkout.sessions.create({
      customer: customer_id,
      client_reference_id: user['user-id'],
      payment_method_types: ['card'],
      mode: 'setup',
      setup_intent_data: {
        metadata: {
          customer_id,
          subscription_id,
        },
      },
      success_url,
      cancel_url,
    }, {
      stripe_account: stripeAccountId
    })

    return session
  } catch (e) {
    if (e.code === 'url_invalid') {
      throw {
        status: statusCodes['Bad Request'],
        error: e.param === 'success_url'
          ? 'SuccessUrlInvalid'
          : 'CancelUrlInvalid'
      }
    }

    throw e
  }
}

exports.updatePaymentMethod = async function (logChildObject, app, admin, user, success_url, cancel_url) {
  try {
    const stripeAccountId = admin['stripe-account-id']
    logChildObject.stripeAccountId = stripeAccountId
    logChildObject.userEmail = user['email']
    logger.child(logChildObject).info('Creating update payment method session for user')

    let customerId, subscriptionId, useTestClient
    if (app['payments-mode'] === 'prod') {
      customerId = user['prod-stripe-customer-id']
      subscriptionId = user['prod-subscription-id']
    } else if (app['payments-mode'] === 'test') {
      customerId = user['test-stripe-customer-id']
      subscriptionId = user['test-subscription-id']
      useTestClient = true
    } else {
      throw {
        status: statusCodes['Forbidden'],
        error: 'PaymentsDisabled'
      }
    }

    logChildObject.customerId = customerId
    logChildObject.subscriptionId = subscriptionId

    if (!customerId || !subscriptionId) throw {
      status: statusCodes['Payment Required'],
      error: 'SubscriptionNotPurchased'
    }

    const session = await _createStripeUpdatePaymentMethodSession(user, admin, customerId, subscriptionId, success_url, cancel_url, useTestClient)

    logger
      .child({ ...logChildObject, statusCode: statusCodes['Success'] })
      .info('Successfully created update payment session for user')

    return responseBuilder.successResponse(session.id)
  } catch (e) {
    const message = 'Failed to create update payment method session for user.'

    if (e.status && e.error) {
      logger.child({ ...logChildObject, statusCode: e.status, err: e.error }).error(message)
      return responseBuilder.errorResponse(e.status, e.error)
    } else {
      const statusCode = statusCodes['Internal Server Error']

      logger.child({ ...logChildObject, statusCode, err: e }).error(message)
      return responseBuilder.errorResponse(statusCode, message)
    }
  }
}
