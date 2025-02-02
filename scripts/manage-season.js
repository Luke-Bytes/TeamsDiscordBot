import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function createOrActivateSeason(seasonNumber) {
  try {
    const existingSeason = await prisma.season.findUnique({
      where: { number: seasonNumber },
    });

    if (existingSeason) {
      console.log(`Season ${seasonNumber} already exists. Activating it...`);
      await prisma.season.update({
        where: { number: seasonNumber },
        data: { isActive: true },
      });
    } else {
      console.log(`Creating new season ${seasonNumber} and activating it...`);
      await prisma.season.create({
        data: {
          number: seasonNumber,
          name: `Season ${seasonNumber}`,
          startDate: new Date(),
          isActive: true,
        },
      });
    }

    await prisma.season.updateMany({
      where: {
        number: { not: seasonNumber },
        isActive: true,
      },
      data: { isActive: false },
    });

    console.log(`Season ${seasonNumber} is now the active season.`);
  } catch (error) {
    console.error("Error updating seasons:", error);
  } finally {
    await prisma.$disconnect();
  }
}

const seasonNumber = parseInt(process.argv[2]);
if (!isNaN(seasonNumber)) {
  createOrActivateSeason(seasonNumber);
} else {
  console.error("Please provide a valid season number.");
}
