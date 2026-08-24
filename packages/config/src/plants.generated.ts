// Generated from config/plants.yaml by pnpm config:generate. Do not edit manually.

export const plantConfiguration = {
  plants: [
    {
      id: 'curry-leaves',
      name: 'Curry Leaves',
      species: 'Murraya koenigii',
      room: 'green-room',
      targets: {
        moisture: {
          min: 20,
          max: 50,
        },
        soilTemp: {
          min: 18,
          max: 32,
        },
        dli: {
          min: 4,
          max: 16,
        },
        vpd: {
          min: 0.6,
          max: 1.6,
        },
        conductivity: {
          min: 200,
          max: 1500,
        },
      },
      watering: {
        maxSeconds: 20,
        minIntervalHours: 48,
        moistureCeiling: 35,
        maxRunsPerDay: 2,
      },
      entities: {
        moisture: 'sensor.ble_moisture_5c857e13542f',
        soilTemp: 'sensor.ble_temperature_5c857e13542f',
        lux: 'sensor.ble_illuminance_5c857e13542f',
        conductivity: 'sensor.ble_conductivity_5c857e13542f',
        airTemp: 'sensor.curry_leaves_temperature_2',
        humidity: 'sensor.curry_leaves_humidity_2',
      },
    },
  ],
} as const;
