import aws from 'aws-sdk'
import os from 'os'
import logger from './logger'
import crypto from './crypto'

let awsAccountId
let initialized = false

const defaultRegion = 'us-west-2'

const defineUsername = () => {
  let appUsername = ''
  if (process.env.NODE_ENV == 'development') {
    if (process.env.USERNAME) {
      appUsername = process.env.USERNAME
    } else {
      appUsername = os.userInfo().username
    }
  } else {
    appUsername = 'prod-v1'
  }
  return appUsername
}

logger.info("Running as USER: " + defineUsername())

// if running in dev mode, prefix the DynamoDB tables and S3 buckets with the username
const resourceNamePrefix = 'userbase-' + defineUsername() + '-'
const ddbTableGroup = 'userbase-' + defineUsername()

const adminTableName = resourceNamePrefix + 'admins'
const appsTableName = resourceNamePrefix + 'apps'
const usersTableName = resourceNamePrefix + 'users'
const sessionsTableName = resourceNamePrefix + 'sessions'
const databaseTableName = resourceNamePrefix + 'databases'
const userDatabaseTableName = resourceNamePrefix + 'user-databases'
const transactionsTableName = resourceNamePrefix + 'transactions'
const dbStatesBucketNamePrefix = resourceNamePrefix + 'database-states'
const secretManagerSecretId = resourceNamePrefix + 'env'

exports.adminTableName = adminTableName
exports.appsTableName = appsTableName
exports.usersTableName = usersTableName
exports.sessionsTableName = sessionsTableName
exports.databaseTableName = databaseTableName
exports.userDatabaseTableName = userDatabaseTableName
exports.transactionsTableName = transactionsTableName

const adminIdIndex = 'AdminIdIndex'
const userIdIndex = 'UserIdIndex'
const appIdIndex = 'AppIdIndex'

exports.adminIdIndex = adminIdIndex
exports.userIdIndex = userIdIndex
exports.appIdIndex = appIdIndex

const getDbStatesBucketName = function () {
  if (!initialized || !awsAccountId) {
    throw new Error('Setup not initialized')
  }

  return dbStatesBucketNamePrefix + '-' + awsAccountId
}

let s3
const getS3Connection = () => s3
exports.s3 = getS3Connection
exports.getDbStatesBucketName = getDbStatesBucketName

let sm
exports.getSecrets = getSecrets
exports.updateSecrets = updateSecrets

exports.init = async function () {
  // look for AWS credentials under the 'encrypted' profile
  const profile = 'encrypted'

  // create a custom AWS credentials chain to provide the custom profile
  const chain = new aws.CredentialProviderChain([
    function () { return new aws.EnvironmentCredentials('AWS') },
    function () { return new aws.EnvironmentCredentials('AMAZON') },
    function () { return new aws.SharedIniFileCredentials({ profile }) },
    function () { return new aws.ECSCredentials() },
    function () { return new aws.ProcessCredentials({ profile }) },
    function () { return new aws.EC2MetadataCredentials() }
  ])

  logger.info('Loading AWS credentials')
  // eslint-disable-next-line require-atomic-updates
  aws.config.credentials = await chain.resolvePromise()

  const region = await getEC2Region() || defaultRegion

  aws.config.update({ region })

  // get the AWS account id
  const accountInfo = await (new aws.STS({ apiVersion: '2011-06-15' })).getCallerIdentity({}).promise()
  awsAccountId = accountInfo.Account
  logger.info(`Running as Account ID: ${awsAccountId}`)

  initialized = true

  await setupDdb()
  await setupS3()
  await setupSM()
}

async function setupDdb() {
  const ddb = new aws.DynamoDB({ apiVersion: '2012-08-10' })

  // the admin table holds a record per admin account
  const adminTableParams = {
    TableName: adminTableName,
    BillingMode: 'PAY_PER_REQUEST',
    AttributeDefinitions: [
      { AttributeName: 'email', AttributeType: 'S' },
      { AttributeName: 'admin-id', AttributeType: 'S' }
    ],
    KeySchema: [
      { AttributeName: 'email', KeyType: 'HASH' }
    ],
    GlobalSecondaryIndexes: [{
      IndexName: adminIdIndex,
      KeySchema: [
        { AttributeName: 'admin-id', KeyType: 'HASH' }
      ],
      Projection: { ProjectionType: 'ALL' }
    }]
  }

  // the apps table holds a record for apps per admin account
  const appsTableParams = {
    TableName: appsTableName,
    BillingMode: 'PAY_PER_REQUEST',
    AttributeDefinitions: [
      { AttributeName: 'admin-id', AttributeType: 'S' },
      { AttributeName: 'app-name', AttributeType: 'S' },
      { AttributeName: 'app-id', AttributeType: 'S' }
    ],
    KeySchema: [
      { AttributeName: 'admin-id', KeyType: 'HASH' },
      { AttributeName: 'app-name', KeyType: 'RANGE' }
    ],
    GlobalSecondaryIndexes: [{
      IndexName: appIdIndex,
      KeySchema: [
        { AttributeName: 'app-id', KeyType: 'HASH' }
      ],
      Projection: { ProjectionType: 'ALL' }
    }]
  }

  // the users table holds a record for user per app
  const usersTableParams = {
    TableName: usersTableName,
    BillingMode: 'PAY_PER_REQUEST',
    AttributeDefinitions: [
      { AttributeName: 'username', AttributeType: 'S' },
      { AttributeName: 'app-id', AttributeType: 'S' },
      { AttributeName: 'user-id', AttributeType: 'S' }
    ],
    KeySchema: [
      { AttributeName: 'username', KeyType: 'HASH' },
      { AttributeName: 'app-id', KeyType: 'RANGE' }
    ],
    GlobalSecondaryIndexes: [
      {
        IndexName: userIdIndex,
        KeySchema: [
          { AttributeName: 'user-id', KeyType: 'HASH' }
        ],
        Projection: { ProjectionType: 'ALL' }
      },
      {
        IndexName: appIdIndex,
        KeySchema: [
          { AttributeName: 'app-id', KeyType: 'HASH' }
        ],
        Projection: { ProjectionType: 'ALL' }
      }
    ]
  }

  // the sessions table holds a record per admin OR user session
  const sessionsTableParams = {
    AttributeDefinitions: [
      { AttributeName: 'session-id', AttributeType: 'S' }
    ],
    KeySchema: [
      { AttributeName: 'session-id', KeyType: 'HASH' }
    ],
    BillingMode: 'PAY_PER_REQUEST',
    TableName: sessionsTableName
  }

  // the database table holds a record per database
  const databaseTableParams = {
    AttributeDefinitions: [
      { AttributeName: 'database-id', AttributeType: 'S' }
    ],
    KeySchema: [
      { AttributeName: 'database-id', KeyType: 'HASH' },
    ],
    BillingMode: 'PAY_PER_REQUEST',
    TableName: databaseTableName,
  }

  // the user database table holds a record for each user database relationship
  const userDatabaseTableParams = {
    AttributeDefinitions: [
      { AttributeName: 'user-id', AttributeType: 'S' },
      { AttributeName: 'database-name-hash', AttributeType: 'S' }
    ],
    KeySchema: [
      { AttributeName: 'user-id', KeyType: 'HASH' },
      { AttributeName: 'database-name-hash', KeyType: 'RANGE' }
    ],
    BillingMode: 'PAY_PER_REQUEST',
    TableName: userDatabaseTableName
  }

  // the transactions table holds a record per database transaction
  const transactionsTableParams = {
    AttributeDefinitions: [
      { AttributeName: 'database-id', AttributeType: 'S' },
      { AttributeName: 'sequence-no', AttributeType: 'N' }
    ],
    KeySchema: [
      { AttributeName: 'database-id', KeyType: 'HASH' },
      { AttributeName: 'sequence-no', KeyType: 'RANGE' }
    ],
    BillingMode: 'PAY_PER_REQUEST',
    TableName: transactionsTableName
  }

  logger.info('Creating DynamoDB tables if necessary')
  await Promise.all([
    createTable(ddb, adminTableParams),
    createTable(ddb, appsTableParams),
    createTable(ddb, usersTableParams),
    createTable(ddb, sessionsTableParams),
    createTable(ddb, databaseTableParams),
    createTable(ddb, userDatabaseTableParams),
    createTable(ddb, transactionsTableParams),
  ])

}

async function setupS3() {
  s3 = new aws.S3({ apiVersion: '2006-03-01' })

  const bucketParams = {
    Bucket: getDbStatesBucketName(),
    ACL: 'private'
  }

  logger.info('Creating S3 bucket if necessary')
  await createBucket(s3, bucketParams)
}

async function createTable(ddb, params) {
  params.Tags = [{ Key: 'DDBTableGroupKey-' + ddbTableGroup, Value: ddbTableGroup }]

  try {
    await ddb.createTable(params).promise()
    logger.info(`Table ${params.TableName} created successfully`)
  } catch (e) {
    if (!e.message.includes('Table already exists')) {
      throw e
    }
  }

  await ddb.waitFor('tableExists', { TableName: params.TableName, $waiter: { delay: 2, maxAttempts: 60 } }).promise()

  const enableBackup = async function () {
    try {
      await ddb.updateContinuousBackups({ TableName: params.TableName, PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true } }).promise()
    } catch (e) {
      if (e.code === 'ContinuousBackupsUnavailableException') {
        setTimeout(enableBackup, 15000)
      } else {
        logger.error(e)
        throw e
      }
    }
  }

  enableBackup()
}

async function createBucket(s3, params) {
  try {
    await s3.createBucket(params).promise()
    logger.info(`Bucket ${params.Bucket} created successfully`)
  } catch (e) {
    if (!e.message.includes('Your previous request to create the named bucket succeeded')) {
      throw e
    }
  }

  await s3.waitFor('bucketExists', { Bucket: params.Bucket, $waiter: { delay: 2, maxAttempts: 60 } }).promise()

  await s3.putPublicAccessBlock({
    Bucket: params.Bucket,
    PublicAccessBlockConfiguration: {
      BlockPublicAcls: true,
      BlockPublicPolicy: true,
      IgnorePublicAcls: true,
      RestrictPublicBuckets: true
    }
  }).promise()

  await s3.putBucketEncryption({
    Bucket: params.Bucket,
    ServerSideEncryptionConfiguration: {
      Rules: [{ ApplyServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } }]
    }
  }).promise()
}

async function setupSM() {
  logger.info('Setting environment variables from secrets manager')
  sm = new aws.SecretsManager()

  const secrets = await getSecrets()

  if (!secrets[crypto.diffieHellman.dhPrivateKeyName]) {
    await setupDhSecret(secrets)
  }

  for (const [key, value] of Object.entries(secrets)) {
    process.env['sm.' + key] = value
  }
}

async function setupDhSecret(secrets) {
  const dhPrivateKey = crypto.diffieHellman.generatePrivateKey().toString('hex')

  await updateSecrets(secrets, crypto.diffieHellman.dhPrivateKeyName, dhPrivateKey)

  logger.info('Successfully created diffie hellman private key')
}

async function getSecrets() {
  try {
    await sm.createSecret({ Name: secretManagerSecretId }).promise()
  } catch (e) {
    if (e.code !== 'ResourceExistsException') {
      throw e
    }
  }

  try {
    const secret = await sm.getSecretValue({ SecretId: secretManagerSecretId }).promise()
    const secrets = JSON.parse(secret.SecretString)
    return secrets
  } catch (e) {
    if (e.code !== 'ResourceNotFoundException') {
      throw e
    }
    return {}
  }
}

async function updateSecrets(secrets, secretKeyName, secretValue) {
  secrets[secretKeyName] = secretValue

  const params = {
    SecretId: secretManagerSecretId,
    SecretString: JSON.stringify(secrets)
  }

  await sm.updateSecret(params).promise()

  process.env['sm.' + secretKeyName] = secretValue
}

async function getEC2Region() {
  try {
    return await new Promise((resolve, reject) => {
      new aws.MetadataService({
        httpOptions: {
          timeout: 2000,
          maxRetries: 0
        }
      }).request("/latest/dynamic/instance-identity/document", function (err, data) {
        if (err) {
          reject(err)
          return
        }
        const ec2Region = JSON.parse(data).region
        logger.info(`Running on EC2 in ${ec2Region}`)
        resolve(ec2Region)
      })
      setTimeout(() => reject(new Error('timeout')), 5000)
    })
  } catch {
    logger.info(`Not running on EC2 - Using default region: ${defaultRegion}`)
    return null
  }
}
