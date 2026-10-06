package com.sentrifugo.db.util;

import com.sentrifugo.db.entity.PmsGoalTemplateEntity;
import org.springframework.data.jpa.domain.Specification;

import java.util.UUID;

/** Filters for the goal-template list (screen 2.1); every filter except the organisation is optional. */
public final class PmsGoalTemplateSpecifications {

    private PmsGoalTemplateSpecifications() {
    }

    public static Specification<PmsGoalTemplateEntity> matching(String organisationId, String financialYear,
                                                                String departmentId, String plantId, String search) {
        Specification<PmsGoalTemplateEntity> spec = (root, query, cb) -> cb.and(
                cb.equal(root.get("organisationId"), organisationId), cb.isTrue(root.get("isActive")));
        if (financialYear != null && !financialYear.isBlank()) {
            spec = spec.and((root, query, cb) -> cb.equal(root.get("financialYear"), financialYear.trim()));
        }
        if (departmentId != null) {
            spec = spec.and((root, query, cb) -> cb.equal(root.get("departmentId"), departmentId));
        }
        if (plantId != null) {
            spec = spec.and((root, query, cb) -> cb.equal(root.get("plantId"), plantId));
        }
        if (search != null && !search.isBlank()) {
            String pattern = "%" + search.trim().toLowerCase() + "%";
            spec = spec.and((root, query, cb) -> cb.like(cb.lower(root.get("templateName")), pattern));
        }
        return spec;
    }
}
