package com.sentrifugo.db.util;

import com.sentrifugo.db.entity.PmsCycleEntity;
import com.sentrifugo.db.enums.PmsCycleStatus;
import com.sentrifugo.db.enums.PmsCycleType;
import org.springframework.data.jpa.domain.Specification;

import java.time.LocalDate;
import java.time.Month;
import java.util.UUID;

/**
 * Filters for the cycle list screen. Every specification is organisation-scoped.
 * {@link #matching} applies the filters shared by the list and its status summary;
 * {@link #statusIs} is added on top for the page itself, so the summary counts stay
 * stable while a status tab is selected.
 */
public final class PmsCycleSpecifications {

    private PmsCycleSpecifications() {
    }

    public static Specification<PmsCycleEntity> matching(UUID organisationId, String search,
                                                         Integer financialYearStart, PmsCycleType type) {
        return matching(organisationId, search, financialYearStart, type, null);
    }

    public static Specification<PmsCycleEntity> matching(UUID organisationId, String search,
                                                         Integer financialYearStart, PmsCycleType type,
                                                         UUID plantId) {
        return inOrganisation(organisationId)
                .and(matchesSearch(search))
                .and(inFinancialYear(financialYearStart))
                .and(typeIs(type))
                .and(coversPlant(plantId));
    }

    /** Cycles that list the plant explicitly, or whose applicability is "all plants". */
    private static Specification<PmsCycleEntity> coversPlant(UUID plantId) {
        if (plantId == null) {
            return always();
        }
        return (root, query, cb) -> {
            var plants = query.subquery(UUID.class);
            var plant = plants.from(com.sentrifugo.db.entity.PmsCyclePlantEntity.class);
            plants.select(plant.get("id")).where(
                    cb.equal(plant.get("cycle"), root), cb.equal(plant.get("plantId"), plantId));
            var all = query.subquery(UUID.class);
            var applicability = all.from(com.sentrifugo.db.entity.PmsCycleApplicabilityEntity.class);
            all.select(applicability.get("id")).where(
                    cb.equal(applicability.get("cycle"), root), cb.isTrue(applicability.get("allPlants")));
            return cb.or(cb.exists(plants), cb.exists(all));
        };
    }

    public static Specification<PmsCycleEntity> statusIs(PmsCycleStatus status) {
        if (status == null) {
            return always();
        }
        return (root, query, cb) -> cb.equal(root.get("status"), status);
    }

    private static Specification<PmsCycleEntity> always() {
        return (root, query, cb) -> cb.conjunction();
    }

    private static Specification<PmsCycleEntity> inOrganisation(UUID organisationId) {
        return (root, query, cb) -> cb.equal(root.get("organisationId"), organisationId);
    }

    private static Specification<PmsCycleEntity> matchesSearch(String search) {
        if (search == null || search.isBlank()) {
            return always();
        }
        String pattern = "%" + search.trim().toLowerCase() + "%";
        return (root, query, cb) -> cb.or(
                cb.like(cb.lower(root.get("cycleCode")), pattern),
                cb.like(cb.lower(root.get("name")), pattern));
    }

    /** A fiscal year April(Y)–March(Y+1) matches any cycle whose period overlaps it. */
    private static Specification<PmsCycleEntity> inFinancialYear(Integer financialYearStart) {
        if (financialYearStart == null) {
            return always();
        }
        LocalDate fyStart = LocalDate.of(financialYearStart, Month.APRIL, 1);
        LocalDate fyEnd = LocalDate.of(financialYearStart + 1, Month.MARCH, 31);
        return (root, query, cb) -> cb.and(
                cb.lessThanOrEqualTo(root.get("periodStart"), fyEnd),
                cb.greaterThanOrEqualTo(root.get("periodEnd"), fyStart));
    }

    private static Specification<PmsCycleEntity> typeIs(PmsCycleType type) {
        if (type == null) {
            return always();
        }
        return (root, query, cb) -> cb.equal(root.get("type"), type);
    }
}
